// ── agent/ipc-stdio-loop.ts — headless NDJSON driver ─────────────────
//
// Replaces the readline REPL when `--ipc-stdio` is passed. The host
// (Electron renderer, IDE plugin, remote control plane, …) speaks the
// same NDJSON dialect that {@link JsonLinesUI} emits on stdout: every
// frame is one line `{ "v": 1, "t": <tag>, "data": <payload> }`
// terminated by `\n`. See `docs/IPC-PROTOCOL.md` for the wire format.
//
// This module is intentionally decoupled from the SDK and from
// `src/agent/index.ts` — it takes a small dependency record so it can
// be unit-tested in isolation by feeding a `Readable` and asserting
// `processMessage`/`triggerAbort` are called with the right shape.
//
// Lifecycle:
//   1. Bootstrap (in index.ts) constructs `JsonLinesUI`, builds the
//      session + state the same as the REPL path, then calls
//      `runIpcStdioLoop({...}, { input: process.stdin })`.
//   2. The loop reads stdin line-by-line, parses each line as a JSON
//      frame, and dispatches by `t` (kebab-case tag).
//   3. `user-input` frames are queued and processed sequentially —
//      one in flight at a time — with any `attachments` from the
//      frame staged onto `state.pendingAttachments` before the call.
//   4. `approval-response`/`choice-response`/`text-response`/
//      `inline-response` frames route to `JsonLinesUI.resolve*`
//      which unblocks the `await` inside the pending modal prompt.
//   5. `abort` frame calls the injected `triggerAbort` (same code
//      path the ESC key takes in REPL mode).
//   6. `shutdown` frame (or stdin EOF) closes the readline reader,
//      cancels every outstanding modal with safe defaults, and
//      resolves the loop promise.
//
// Malformed frames emit an `error`-level notification on the wire and
// the loop continues — a single bad frame must never kill the agent.
// ─────────────────────────────────────────────────────────────────────

import readline from "node:readline";
import type { Readable } from "node:stream";
import type { JsonLinesUI } from "./ui/json-lines-ui.js";
import type { AgentState } from "./state.js";
import type { SessionAttachment } from "./attachments.js";

// ── Frame Schema ─────────────────────────────────────────────────────
//
// Inbound (host → agent) frames. The outbound (agent → host) shapes
// are owned by `JsonLinesUI` — see `src/agent/ui/json-lines-ui.ts`.

/** User typed a message (or pasted one). Optional attachments are pushed verbatim. */
interface UserInputFrame {
  readonly t: "user-input";
  readonly data: {
    readonly text: string;
    readonly attachments?: readonly SessionAttachment[];
  };
}

/** Host's answer to a previously emitted `ask-approval` frame. */
interface ApprovalResponseFrame {
  readonly t: "approval-response";
  readonly data: {
    readonly id: string;
    readonly choice: "yes" | "no";
  };
}

/** Host's answer to a previously emitted `ask-choice` frame. */
interface ChoiceResponseFrame {
  readonly t: "choice-response";
  readonly data: {
    readonly id: string;
    readonly answer: string;
    readonly wasFreeform?: boolean;
  };
}

/** Host's answer to a previously emitted `ask-text` frame. */
interface TextResponseFrame {
  readonly t: "text-response";
  readonly data: {
    readonly id: string;
    readonly answer: string;
  };
}

/** Host's answer to a previously emitted `ask-inline` frame. */
interface InlineResponseFrame {
  readonly t: "inline-response";
  readonly data: {
    readonly id: string;
    readonly answer: string;
  };
}

/** Host requests the in-flight turn be cancelled (ESC equivalent). */
interface AbortFrame {
  readonly t: "abort";
}

/** Host requests the agent shut down cleanly. */
interface ShutdownFrame {
  readonly t: "shutdown";
}

type InboundFrame =
  | UserInputFrame
  | ApprovalResponseFrame
  | ChoiceResponseFrame
  | TextResponseFrame
  | InlineResponseFrame
  | AbortFrame
  | ShutdownFrame;

// ── Dependency Injection ─────────────────────────────────────────────

/**
 * Injection record for {@link runIpcStdioLoop}. Keeps this module
 * decoupled from `src/agent/index.ts` (a giant file) and from the
 * Copilot SDK — the caller closes over `session`/sdk objects.
 */
export interface IpcLoopDeps {
  /** The headless UI port. Same instance the bootstrap wired into the session. */
  readonly ui: JsonLinesUI;
  /** Agent state — used to stage attachments before {@link processMessage}. */
  readonly state: AgentState;
  /**
   * Run one full turn: send the user input to the agent and wait
   * for the full response. Closes over `(session, …)`; the loop only
   * sees the user-visible argument. Returns when the turn finishes.
   */
  readonly processMessage: (userInput: string) => Promise<unknown>;
  /**
   * Cancel the in-flight turn. Closes over `(session, state, ui)`;
   * the loop only sees a zero-arg function. Same code path the ESC
   * key uses in REPL mode (see `src/agent/abort-controller.ts`).
   */
  readonly triggerAbort: () => void;
  /** Optional debug logger — receives one-line tracer messages. */
  readonly debugLog?: (msg: string) => void;
}

/** Tuning knobs for {@link runIpcStdioLoop}. */
export interface IpcLoopOptions {
  /** Input stream of NDJSON frames. Defaults to `process.stdin`. */
  readonly input?: Readable;
}

// ── Loop Implementation ──────────────────────────────────────────────

/**
 * Drive the agent off an NDJSON stdin stream. Returns when the loop
 * exits (either a `shutdown` frame arrived, or the input stream
 * closed). The promise never rejects — every error is surfaced as an
 * `error`-level notification on the wire.
 */
export async function runIpcStdioLoop(
  deps: IpcLoopDeps,
  opts: IpcLoopOptions = {},
): Promise<void> {
  const input = opts.input ?? process.stdin;
  const debug = deps.debugLog ?? (() => {});

  // Sequential user-input queue. Only one `processMessage` is ever in
  // flight; subsequent inputs queue until the current turn returns.
  // Modal prompts (resolve*) and `abort` can interleave because they
  // don't go through this queue — they reach into the UI's pending
  // map / call `session.abort()` directly.
  const queue: UserInputFrame["data"][] = [];
  let draining = false;
  // Tracks the in-flight drain promise so the close-handler can wait
  // for any queued turns to finish before resolving the loop. Without
  // this, EOF would race with the drain and return early.
  let drainPromise: Promise<void> = Promise.resolve();

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const next = queue.shift()!;
        if (next.attachments && next.attachments.length > 0) {
          // Stage host-supplied attachments. The next `processMessage`
          // call drains `state.pendingAttachments` atomically inside
          // `prepareTurnAttachments` (Phase 6.5a).
          deps.state.pendingAttachments = [
            ...deps.state.pendingAttachments,
            ...next.attachments,
          ];
        }
        try {
          await deps.processMessage(next.text);
        } catch (err) {
          // processMessage normally swallows its own errors; this is
          // a defence-in-depth catch so one bad turn can't kill the loop.
          const message = err instanceof Error ? err.message : String(err);
          debug(`ipc: processMessage threw: ${message}`);
          deps.ui.emitNotification({
            level: "error",
            kind: "generic",
            icon: "❌",
            message: `Turn failed: ${message}`,
          });
        }
      }
    } finally {
      draining = false;
    }
  };

  const triggerDrain = (): void => {
    if (draining) return;
    drainPromise = drain();
  };

  return new Promise<void>((resolveLoop) => {
    const rl = readline.createInterface({
      input,
      crlfDelay: Infinity,
    });

    let shuttingDown = false;
    const requestShutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      // Closing the readline interface fires the `close` event which
      // runs the cleanup branch below. Don't cancel pending or
      // resolve here — keep all teardown in one place.
      rl.close();
    };

    rl.on("line", (rawLine) => {
      const line = rawLine.trim();
      if (line.length === 0) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        debug(`ipc: malformed JSON: ${message}`);
        deps.ui.emitNotification({
          level: "error",
          kind: "generic",
          icon: "❌",
          message: `IPC: malformed JSON (${message})`,
        });
        return;
      }

      const frame = parsed as Partial<InboundFrame> | null;
      if (!frame || typeof frame !== "object" || typeof frame.t !== "string") {
        debug(`ipc: dropped frame with no t field: ${line}`);
        deps.ui.emitNotification({
          level: "error",
          kind: "generic",
          icon: "❌",
          message: `IPC: frame missing "t" tag`,
        });
        return;
      }

      handleFrame(frame as InboundFrame);
    });

    rl.on("close", () => {
      debug("ipc: stdin closed — draining queue then exiting");
      // Wait for any in-flight drain to finish before resolving so
      // queued turns (or the currently-running turn) get a chance to
      // complete. `.then(() => undefined)` to satisfy the void return.
      drainPromise
        .catch(() => {
          // drain swallows its own errors — this catch exists only
          // to satisfy the promise contract; unreachable in practice.
        })
        .then(() => {
          deps.ui.cancelAllPending();
          resolveLoop();
        });
    });

    rl.on("error", (err) => {
      // readline errors are unusual but possible (e.g. EIO on a
      // broken pipe). Surface and exit cleanly.
      const message = err instanceof Error ? err.message : String(err);
      debug(`ipc: readline error: ${message}`);
      requestShutdown();
    });

    const handleFrame = (frame: InboundFrame): void => {
      switch (frame.t) {
        case "user-input": {
          const data = frame.data;
          if (!data || typeof data.text !== "string") {
            deps.ui.emitNotification({
              level: "error",
              kind: "generic",
              icon: "❌",
              message: `IPC: user-input frame missing text`,
            });
            return;
          }
          const attachments = sanitiseAttachments(data.attachments, deps.ui);
          queue.push({ text: data.text, attachments });
          // Fire-and-forget — `drain` self-serialises via the `draining` guard.
          triggerDrain();
          return;
        }
        case "approval-response": {
          const d = frame.data;
          if (
            !d ||
            typeof d.id !== "string" ||
            (d.choice !== "yes" && d.choice !== "no")
          ) {
            deps.ui.emitNotification({
              level: "error",
              kind: "generic",
              icon: "❌",
              message: `IPC: approval-response missing id/choice`,
            });
            return;
          }
          const accepted = deps.ui.resolveApproval(d.id, d.choice);
          if (!accepted) {
            debug(`ipc: approval-response for unknown id ${d.id}`);
          }
          return;
        }
        case "choice-response": {
          const d = frame.data;
          if (!d || typeof d.id !== "string" || typeof d.answer !== "string") {
            deps.ui.emitNotification({
              level: "error",
              kind: "generic",
              icon: "❌",
              message: `IPC: choice-response missing id/answer`,
            });
            return;
          }
          const accepted = deps.ui.resolveChoice(d.id, {
            answer: d.answer,
            wasFreeform: d.wasFreeform === true,
          });
          if (!accepted) {
            debug(`ipc: choice-response for unknown id ${d.id}`);
          }
          return;
        }
        case "text-response": {
          const d = frame.data;
          if (!d || typeof d.id !== "string" || typeof d.answer !== "string") {
            deps.ui.emitNotification({
              level: "error",
              kind: "generic",
              icon: "❌",
              message: `IPC: text-response missing id/answer`,
            });
            return;
          }
          const accepted = deps.ui.resolveText(d.id, d.answer);
          if (!accepted) {
            debug(`ipc: text-response for unknown id ${d.id}`);
          }
          return;
        }
        case "inline-response": {
          const d = frame.data;
          if (!d || typeof d.id !== "string" || typeof d.answer !== "string") {
            deps.ui.emitNotification({
              level: "error",
              kind: "generic",
              icon: "❌",
              message: `IPC: inline-response missing id/answer`,
            });
            return;
          }
          const accepted = deps.ui.resolveInline(d.id, d.answer);
          if (!accepted) {
            debug(`ipc: inline-response for unknown id ${d.id}`);
          }
          return;
        }
        case "abort": {
          debug("ipc: abort frame received");
          try {
            deps.triggerAbort();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            debug(`ipc: triggerAbort threw: ${message}`);
          }
          return;
        }
        case "shutdown": {
          debug("ipc: shutdown frame received");
          requestShutdown();
          return;
        }
        default: {
          // Exhaustiveness check at compile time — runtime fallback
          // for forward-compatible hosts that emit newer tags.
          const exhaustive: never = frame;
          void exhaustive;
          deps.ui.emitNotification({
            level: "error",
            kind: "generic",
            icon: "❌",
            message: `IPC: unknown frame tag`,
          });
          return;
        }
      }
    };
  });
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Validate host-supplied attachments. Drops malformed entries (logs
 * one warning per drop) rather than failing the whole turn — partial
 * success is preferable to losing the user's text.
 *
 * The SDK does its own thorough validation downstream; this is a
 * cheap pre-flight that catches obvious type mistakes.
 */
function sanitiseAttachments(
  raw: readonly SessionAttachment[] | undefined,
  ui: JsonLinesUI,
): SessionAttachment[] {
  if (!raw || raw.length === 0) return [];
  const out: SessionAttachment[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i] as unknown;
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as { type?: unknown }).type !== "string"
    ) {
      ui.emitNotification({
        level: "warning",
        kind: "generic",
        icon: "⚠️",
        message: `IPC: dropping attachment ${i} — missing "type"`,
      });
      continue;
    }
    out.push(entry as SessionAttachment);
  }
  return out;
}
