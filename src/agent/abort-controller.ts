// ── agent/abort-controller.ts — ESC-key cancellation ─────────────────
//
// Enables the user to press ESC during LLM reasoning/streaming to
// abort the current request. Uses the SDK's session.abort() API for
// clean cancellation — no hack, no workaround.
//
// Lifecycle:
//   1. enableAbortOnEsc(session, state, spinner) — enter raw mode,
//      listen for bare ESC keypress
//   2. On ESC → session.abort() → SDK sends abort RPC → abort event
//      arrives → event handler resolves the pending promise
//   3. disableAbortOnEsc() — remove listener, restore readline control
// ─────────────────────────────────────────────────────────────────────

import type { CopilotSession } from "@github/copilot-sdk";
import type { AgentState } from "./state.js";
import type { Spinner } from "./spinner.js";
import { C } from "./ansi.js";

// ── Constants ────────────────────────────────────────────────────────

/** ESC character code (0x1B). Also the prefix for ANSI escape sequences. */
const ESC_CHAR = "\x1b";

/**
 * Debounce window (ms) to distinguish a bare ESC press from the start
 * of an ANSI escape sequence (e.g. arrow keys emit ESC + '[' + char).
 * If no follow-up byte arrives within this window, it's a real ESC.
 */
const ESC_DEBOUNCE_MS = 80;

/**
 * How long to wait (ms) after calling session.abort() for the SDK to
 * deliver the abort event before we force-resolve the pending promise.
 * Without this, a successful abort() that never gets an event response
 * leaves processMessage() hanging forever.
 */
const ABORT_FALLBACK_MS = 3000;

// ── Module State ─────────────────────────────────────────────────────
// Kept minimal — only lives for the duration of a single processMessage.

/** The currently active keypress listener, or null if not armed. */
let activeListener: ((data: Buffer) => void) | null = null;

/** Debounce timer for ESC detection. */
let escTimer: ReturnType<typeof setTimeout> | null = null;

/** Whether an abort has already been triggered for this cycle. */
let abortFired = false;

/** Whether we set raw mode (so we know to restore it on disarm). */
let didSetRawMode = false;

// ── Public API ───────────────────────────────────────────────────────

/**
 * Arm the ESC-key abort handler. Call this just before entering the
 * sendAndWait cycle. The handler tears itself down automatically
 * after firing, or you call `disableAbortOnEsc()` in the finally block.
 *
 * @param session - The active CopilotSession (has .abort())
 * @param agentState  - AgentState (pendingResolve/Reject for fallback resolution)
 * @param spin    - Spinner instance (stopped on abort for clean UI)
 */
export function enableAbortOnEsc(
  session: CopilotSession,
  agentState: AgentState,
  spin: Spinner,
  log?: (msg: string) => void,
): void {
  disableAbortOnEsc();
  abortFired = false;
  const dbg = agentState.debugEnabled && log ? log : () => {};

  if (!process.stdin.isTTY) return;

  // Enter raw mode so individual keypresses (including ESC) are
  // delivered immediately instead of waiting for Enter. Without this,
  // ESC is line-buffered and never reaches our listener.
  // Also prevents typed characters from being "eaten" — in raw mode
  // we see them and can ignore non-ESC input cleanly.
  if (typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(true);
    didSetRawMode = true;
  }

  // Ensure stdin is flowing — readline may have paused it after the
  // last question() completed. Without resume(), no 'data' events
  // fire and ESC presses are silently swallowed.
  if (process.stdin.isPaused()) {
    process.stdin.resume();
    dbg("ESC: stdin was paused — called resume()");
  }

  // Grace period: ignore ESC bytes that arrive within the first
  // ARM_GRACE_MS of arming. Prevents buffered/stale ESC bytes
  // (e.g. from a rapid double-press in the previous turn) from
  // triggering a phantom cancel on the new turn. 200ms is short
  // enough that real user cancels still feel instant.
  const armTime = Date.now();
  const ARM_GRACE_MS = 200;

  activeListener = (data: Buffer) => {
    if (Date.now() - armTime < ARM_GRACE_MS) {
      dbg(`ESC: swallowed during grace: ${data.toString("hex")}`);
      return;
    }

    const str = data.toString("utf8");
    dbg(
      `ESC: stdin hex=${data.toString("hex")} str=${JSON.stringify(str)} abortFired=${abortFired}`,
    );

    if (str === ESC_CHAR) {
      if (escTimer) clearTimeout(escTimer);
      escTimer = setTimeout(() => {
        escTimer = null;
        dbg(
          `ESC: debounce fired — triggering abort (abortFired=${abortFired})`,
        );
        if (!abortFired) {
          triggerAbort(session, agentState, spin);
        }
      }, ESC_DEBOUNCE_MS);
      return;
    }

    if (escTimer) {
      dbg(`ESC: follow-up byte cancelled debounce (ANSI sequence)`);
      clearTimeout(escTimer);
      escTimer = null;
    }
  };

  process.stdin.on("data", activeListener);
  dbg(
    `ESC: armed — listeners on stdin: ${process.stdin.listenerCount("data")}`,
  );
}

/**
 * Disarm the ESC-key abort handler. Call this in the finally block
 * of processMessage to restore stdin for readline.
 */
export function disableAbortOnEsc(): void {
  if (escTimer) {
    clearTimeout(escTimer);
    escTimer = null;
  }

  if (activeListener) {
    process.stdin.removeListener("data", activeListener);
    activeListener = null;
  }

  // IMPORTANT: Do NOT call setRawMode(false) here!
  // readline maintains its own raw mode state. If we turn it off,
  // readline thinks it's still on and won't re-enable it for the next
  // .question() call. This causes arrow keys to print ^[[A instead of
  // recalling history. Just remove our listener and let readline
  // continue managing stdin in whatever mode it was using.
  didSetRawMode = false;
}

/**
 * Check if the ESC-key abort handler is currently armed.
 */
export function isAbortOnEscEnabled(): boolean {
  return activeListener !== null;
}

// ── Audit Abort ──────────────────────────────────────────────────────

/**
 * Create an abort handler for audit operations.
 *
 * Returns an `AbortController` and arms an ESC-key listener that
 * fires `controller.abort()` on a bare ESC press. Unlike the main
 * session abort, this doesn't need a CopilotSession — it just
 * signals the AbortController so the deepAudit promise can reject.
 *
 * Call `cleanup()` in a finally block to disarm the listener.
 *
 * @param spin - Spinner instance (stopped on abort for clean output)
 * @returns `{ controller, cleanup }` — pass controller.signal to
 *   deepAudit(), call cleanup() when audit completes or fails.
 */
export function createAuditAbortHandler(spin: Spinner): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let listener: ((data: Buffer) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  let auditDidSetRawMode = false;
  let previousRawMode = false;

  if (process.stdin.isTTY) {
    // Enter raw mode so ESC is delivered immediately.
    if (typeof process.stdin.setRawMode === "function") {
      // Remember whether raw mode was already on (readline sets it)
      // so we can restore the correct state on cleanup.
      previousRawMode = process.stdin.isRaw ?? false;
      process.stdin.setRawMode(true);
      auditDidSetRawMode = true;
    }

    // Ensure stdin is flowing (readline may have paused it).
    if (process.stdin.isPaused()) {
      process.stdin.resume();
    }

    listener = (data: Buffer) => {
      const str = data.toString("utf8");

      if (str === ESC_CHAR) {
        // Debounce — distinguish bare ESC from ANSI escape sequences
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          if (!controller.signal.aborted) {
            spin.stop();
            console.log(`\n  ${C.warn("⏹️  Audit cancelled.")}`);
            controller.abort();
          }
        }, ESC_DEBOUNCE_MS);
        return;
      }

      // Follow-up byte arrived — part of an ANSI sequence, not ESC
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    process.stdin.on("data", listener);
  }

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (listener) {
      process.stdin.removeListener("data", listener);
      listener = null;
    }
    // Restore the previous raw mode state. readline needs raw mode ON
    // for arrow key history to work — setting false unconditionally was
    // killing readline's terminal control after every audit.
    if (
      auditDidSetRawMode &&
      process.stdin.isTTY &&
      typeof process.stdin.setRawMode === "function"
    ) {
      process.stdin.setRawMode(previousRawMode);
    }
  };

  return { controller, cleanup };
}

// ── Internals ────────────────────────────────────────────────────────

/**
 * Trigger the cancellation sequence:
 *   1. Stop the spinner (clean up the UI)
 *   2. Call session.abort() (SDK sends RPC to CLI server)
 *   3. The abort event will arrive via the event handler, which
 *      resolves the pending promise — but if abort() itself fails
 *      or the event never arrives, we resolve manually as a fallback.
 */
function triggerAbort(
  session: CopilotSession,
  agentState: AgentState,
  spin: Spinner,
): void {
  abortFired = true;
  agentState.lastResponseWasCancelled = true;
  spin.stop();
  console.log(`\n  ${C.warn("⏹️  Cancelled.")}`);

  /**
   * Force-resolve the pending promise if the SDK abort event never
   * arrives. This is the safety net — without it, processMessage()
   * hangs forever when the server acknowledges the abort but never
   * sends the event back (e.g. model is truly dead server-side).
   */
  const forceResolveIfStillPending = () => {
    if (agentState.pendingResolve) {
      const resolve = agentState.pendingResolve;
      agentState.pendingResolve = null;
      agentState.pendingReject = null;
      if (agentState.keepAliveTimeoutId) {
        clearTimeout(agentState.keepAliveTimeoutId);
        agentState.keepAliveTimeoutId = null;
      }
      resolve(undefined);
    }
  };

  // Start a fallback timer IMMEDIATELY. If the abort event arrives
  // via the normal event handler path, pendingResolve will already
  // be null and the fallback is a harmless no-op.
  const fallbackTimer = setTimeout(
    forceResolveIfStillPending,
    ABORT_FALLBACK_MS,
  );

  // Fire the SDK abort. Whether it succeeds or fails, the fallback
  // timer ensures we always unblock processMessage().
  session.abort().catch(() => {
    // SDK abort failed immediately — force-resolve now, cancel the
    // fallback timer since we're handling it synchronously.
    clearTimeout(fallbackTimer);
    forceResolveIfStillPending();
  });
}
