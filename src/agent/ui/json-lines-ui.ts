// ── agent/ui/json-lines-ui.ts — headless AgentUI over NDJSON ────────
//
// Concrete `AgentUI` that serialises every emit into a single
// newline-delimited JSON object on stdout. Designed for embedding
// the agent in a host process (Electron renderer, IDE plugin,
// remote control plane) that wants structured data rather than ANSI
// terminal bytes.
//
// Wire format (full reference lives in `docs/IPC-PROTOCOL.md`)
// ────────────────────────────────────────────────────────────
//   - One JSON object per line, UTF-8 encoded, trailing `\n`.
//   - Every frame carries `v: 1` (the protocol version) and `t`
//     (the event type — kebab-case string).
//   - Payload-bearing frames carry `data: <object>` whose shape
//     matches the corresponding payload type from `./events.ts`.
//   - Modal-prompt frames (`ask-approval`, `ask-choice`, `ask-text`,
//     `ask-inline`) carry an `id: string` that the host must echo
//     back on the matching response frame.
//
// Reply pump
// ──────────
// Modal prompts await a reply frame on stdin. This class exposes
// `resolveApproval` / `resolveChoice` / `resolveText` /
// `resolveInline` so the surrounding bootstrap loop can route
// incoming stdin frames to the matching pending promise without the
// UI itself having to own a stdin reader. The separation keeps the
// UI deterministic (every method either writes a JSON line or
// returns a promise) and the stdin reader simple (one switch on
// `t`, no state).
//
// Design rules
// ────────────
//   1. **Never throw from emit methods.** A misbehaving host cannot
//      crash the agent loop — the port contract guarantees this and
//      `JsonLinesUI` swallows write errors silently.
//   2. **Pure JSON payloads.** No ANSI, no terminal-specific markup,
//      no functions or class instances. Every field is one of the
//      JSON primitive types so consumers can `JSON.parse` and use
//      the object directly.
//   3. **Stable shape.** This is part of the agent's external
//      contract once the Electron app ships. Add fields cautiously
//      and bump `v` if a backwards-incompatible change is required.
// ────────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import type { AgentUI } from "./port.js";
import type {
  ActivityPayload,
  ApprovalQuestion,
  ChoiceAnswer,
  ChoiceQuestion,
  MarkdownPayload,
  NotificationPayload,
  ReasoningDeltaPayload,
  ReasoningTransitionPayload,
  TextDeltaPayload,
  TextQuestion,
  ToolResultPayload,
  ToolStartPayload,
  UsagePayload,
  WindowTitlePayload,
} from "./events.js";

/** Wire-format protocol version. Bump only on incompatible changes. */
export const JSON_LINES_PROTOCOL_VERSION = 1;

/** Function signature for the byte sink — typically `process.stdout.write`. */
export type JsonLinesWriter = (chunk: string) => void;

/**
 * Construction options for {@link JsonLinesUI}.
 *
 * All fields are optional so unit tests can spin up a UI with no
 * arguments; production wires `write` to `process.stdout.write` and
 * `generateId` defaults to {@link randomUUID}.
 */
export interface JsonLinesUIOptions {
  /**
   * Byte sink for outgoing event frames. Each call receives exactly
   * one line (terminated by `\n`). Defaults to a stdout writer that
   * survives `process.stdout` being reassigned (Phase 5 transcript
   * recorder integration).
   */
  readonly write?: JsonLinesWriter;
  /**
   * Identifier factory for modal-prompt correlation. Tests inject a
   * deterministic counter; production uses cryptographic UUIDs.
   */
  readonly generateId?: () => string;
}

/** Pending modal prompt awaiting a reply frame from stdin. */
interface PendingPrompt<T> {
  readonly kind: "approval" | "choice" | "text" | "inline";
  readonly resolve: (value: T) => void;
}

/**
 * Headless `AgentUI` that writes NDJSON to a configurable sink.
 *
 * Modal-prompt resolution is split: `askApproval` (etc.) writes the
 * request frame and registers a pending resolver; the surrounding
 * stdin reader calls `resolveApproval(id, choice)` (etc.) when the
 * matching reply lands. See `docs/IPC-PROTOCOL.md` for the full
 * protocol description.
 */
export class JsonLinesUI implements AgentUI {
  /** Outgoing-frame byte sink. */
  private readonly _write: JsonLinesWriter;
  /** Identifier factory for modal-prompt correlation. */
  private readonly _generateId: () => string;
  /** Pending modal prompts keyed by the id sent on the request frame. */
  private readonly _pending = new Map<string, PendingPrompt<unknown>>();

  constructor(options: JsonLinesUIOptions = {}) {
    this._write =
      options.write ?? ((chunk: string) => process.stdout.write(chunk));
    this._generateId = options.generateId ?? randomUUID;
  }

  // ── Frame helpers ──────────────────────────────────────────────

  /**
   * Serialise an event frame and forward it to the sink. Wraps the
   * sink in try/catch so a broken downstream pipe can never bubble
   * up into the agent loop — the port contract requires emit methods
   * to be non-throwing.
   */
  private _emit(type: string, data?: unknown): void {
    const frame =
      data === undefined
        ? { v: JSON_LINES_PROTOCOL_VERSION, t: type }
        : { v: JSON_LINES_PROTOCOL_VERSION, t: type, data };
    try {
      this._write(JSON.stringify(frame) + "\n");
    } catch {
      // A misbehaving sink (e.g. closed stdout pipe) must never
      // break the agent loop. Drop the frame silently — the
      // embedder has gone away and the next emit attempt will fail
      // the same way.
    }
  }

  // ── Streaming output ───────────────────────────────────────────

  emitText(payload: TextDeltaPayload): void {
    if (payload.content.length === 0) return;
    this._emit("text-delta", payload);
  }

  emitReasoning(payload: ReasoningDeltaPayload): void {
    if (payload.content.length === 0) return;
    this._emit("reasoning-delta", payload);
  }

  emitReasoningTransition(payload: ReasoningTransitionPayload): void {
    this._emit("reasoning-transition", payload);
  }

  clearReasoningBuffer(): void {
    // No internal reasoning buffer — the structured stream carries
    // each delta verbatim and the host renders them. Emit a marker
    // frame so consumers can drop any UI affordance they were
    // showing for the in-flight reasoning preview.
    this._emit("clear-reasoning-buffer");
  }

  hasBufferedReasoning(): boolean {
    // No internal buffer — see `clearReasoningBuffer`. Callers use
    // this to decide whether to emit a separator before the next
    // visible chunk; for structured hosts the separator decision
    // belongs to the renderer, not the wire format.
    return false;
  }

  setVerboseReasoning(value: boolean): void {
    this._emit("verbose-reasoning", { value });
  }

  renderMarkdown(payload: MarkdownPayload): void {
    if (payload.source.length === 0) return;
    this._emit("markdown", payload);
  }

  // ── Tool calls ─────────────────────────────────────────────────

  emitToolStart(payload: ToolStartPayload): void {
    this._emit("tool-start", payload);
  }

  emitToolResult(payload: ToolResultPayload): void {
    this._emit("tool-result", payload);
  }

  // ── Status / activity ──────────────────────────────────────────

  beginTurn(): void {
    this._emit("begin-turn");
  }

  setActivity(payload: ActivityPayload | null): void {
    // Use `null` (rather than omitting `data`) so consumers can
    // distinguish "no activity right now" from "no payload on this
    // frame type". JSON.stringify drops `undefined` but keeps `null`.
    this._emit("activity", payload);
  }

  setWindowTitle(payload: WindowTitlePayload): void {
    this._emit("window-title", payload);
  }

  // ── Notifications ──────────────────────────────────────────────

  emitNotification(payload: NotificationPayload): void {
    this._emit("notification", payload);
  }

  // ── Usage stats ────────────────────────────────────────────────

  emitUsage(payload: UsagePayload): void {
    this._emit("usage", payload);
  }

  // ── Modal user prompts ─────────────────────────────────────────
  //
  // Each `ask*` method generates a unique id, emits a request frame
  // carrying that id, and registers a one-shot resolver in
  // `_pending`. The surrounding stdin reader routes the matching
  // reply frame back via `resolve*(id, …)`.
  //
  // The port contract requires these promises to resolve with a
  // sensible value (never reject) so callers downstream of the SDK
  // hook contract always get a string back. When the host closes
  // its end of the pipe the bootstrap loop calls `cancelAllPending`
  // which resolves every outstanding prompt with its safe default.

  askApproval(payload: ApprovalQuestion): Promise<"yes" | "no"> {
    const id = this._generateId();
    return new Promise<"yes" | "no">((resolve) => {
      this._pending.set(id, {
        kind: "approval",
        resolve: resolve as (value: unknown) => void,
      });
      this._emit("ask-approval", { id, ...payload });
    });
  }

  askChoice(payload: ChoiceQuestion): Promise<ChoiceAnswer> {
    const id = this._generateId();
    return new Promise<ChoiceAnswer>((resolve) => {
      this._pending.set(id, {
        kind: "choice",
        resolve: resolve as (value: unknown) => void,
      });
      this._emit("ask-choice", { id, ...payload });
    });
  }

  askText(payload: TextQuestion): Promise<string> {
    const id = this._generateId();
    return new Promise<string>((resolve) => {
      this._pending.set(id, {
        kind: "text",
        resolve: resolve as (value: unknown) => void,
      });
      this._emit("ask-text", { id, ...payload });
    });
  }

  askInline(prompt: string): Promise<string> {
    const id = this._generateId();
    return new Promise<string>((resolve) => {
      this._pending.set(id, {
        kind: "inline",
        resolve: resolve as (value: unknown) => void,
      });
      this._emit("ask-inline", { id, prompt });
    });
  }

  // ── Paste-buffer drain ─────────────────────────────────────────

  async drainPasteBuffer(): Promise<void> {
    // No readline → no paste buffer. The headless host owns its own
    // input batching policy.
  }

  // ── Reply routing (consumed by the stdin reader) ───────────────

  /**
   * Route an `approval-response` reply frame to the matching
   * pending {@link askApproval}. Returns `true` when a matching
   * prompt was found and resolved, `false` when the id was unknown
   * or wrong-kind (host bug — silently dropped on the wire).
   */
  resolveApproval(id: string, choice: "yes" | "no"): boolean {
    const pending = this._pending.get(id);
    if (!pending || pending.kind !== "approval") return false;
    this._pending.delete(id);
    pending.resolve(choice);
    return true;
  }

  /**
   * Route a `choice-response` reply frame to the matching pending
   * {@link askChoice}.
   */
  resolveChoice(id: string, answer: ChoiceAnswer): boolean {
    const pending = this._pending.get(id);
    if (!pending || pending.kind !== "choice") return false;
    this._pending.delete(id);
    pending.resolve(answer);
    return true;
  }

  /**
   * Route a `text-response` reply frame to the matching pending
   * {@link askText}.
   */
  resolveText(id: string, answer: string): boolean {
    const pending = this._pending.get(id);
    if (!pending || pending.kind !== "text") return false;
    this._pending.delete(id);
    pending.resolve(answer);
    return true;
  }

  /**
   * Route an `inline-response` reply frame to the matching pending
   * {@link askInline}.
   */
  resolveInline(id: string, answer: string): boolean {
    const pending = this._pending.get(id);
    if (!pending || pending.kind !== "inline") return false;
    this._pending.delete(id);
    pending.resolve(answer);
    return true;
  }

  /**
   * Resolve every outstanding modal prompt with its safe default —
   * called by the bootstrap loop when the host closes stdin (so the
   * agent's pending awaits don't hang the shutdown path forever).
   *
   * Approval prompts resolve with `"no"`, text/inline with `""`,
   * choice with `{ answer: "", wasFreeform: false }`. These match
   * the documented "no interactive input" defaults used by
   * `TerminalUI` when no readline is available.
   */
  cancelAllPending(): void {
    for (const [id, pending] of this._pending) {
      switch (pending.kind) {
        case "approval":
          pending.resolve("no");
          break;
        case "choice":
          pending.resolve({ answer: "", wasFreeform: false });
          break;
        case "text":
        case "inline":
          pending.resolve("");
          break;
      }
      this._pending.delete(id);
    }
  }

  /**
   * For diagnostics and tests: how many prompts are currently
   * awaiting a reply.
   */
  get pendingCount(): number {
    return this._pending.size;
  }
}
