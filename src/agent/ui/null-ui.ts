// ── agent/ui/null-ui.ts — no-op AgentUI implementation ──────────────
//
// Drop-in `AgentUI` that swallows every call. Used by:
//   - Unit tests of agent business logic that don't care about
//     output (e.g. state-mutation tests for `commands.ts`).
//   - Bootstrap paths where the real UI isn't ready yet but we
//     still need a non-null value for type-safety.
//
// Implementation discipline
// ─────────────────────────
//   - Every method does nothing and returns `undefined`.
//   - No state, no side-effects, no allocations on the hot path.
//   - Fields are kept explicit (not via `Object.create(null)`) so
//     the TypeScript checker catches drift if the port grows.
// ────────────────────────────────────────────────────────────────────

import type { AgentUI } from "./port.js";

/**
 * No-op `AgentUI`. All methods are nullary at runtime — the
 * parameters are accepted but never read.
 */
export class NullUI implements AgentUI {
  emitText(): void {
    /* intentionally empty */
  }

  emitReasoning(): void {
    /* intentionally empty */
  }

  emitReasoningTransition(): void {
    /* intentionally empty */
  }

  clearReasoningBuffer(): void {
    /* intentionally empty */
  }

  hasBufferedReasoning(): boolean {
    return false;
  }

  setVerboseReasoning(): void {
    /* intentionally empty */
  }

  renderMarkdown(): void {
    /* intentionally empty */
  }

  emitToolStart(): void {
    /* intentionally empty */
  }

  emitToolResult(): void {
    /* intentionally empty */
  }

  beginTurn(): void {
    /* intentionally empty */
  }

  setActivity(): void {
    /* intentionally empty */
  }

  setWindowTitle(): void {
    /* intentionally empty */
  }

  emitNotification(): void {
    /* intentionally empty */
  }

  emitUsage(): void {
    /* intentionally empty */
  }

  // ── Modal user prompts ─────────────────────────────────────────
  //
  // These reject instead of returning a default. Tests that reach a
  // modal prompt with `NullUI` in place have almost certainly
  // forgotten to install a real UI — a loud rejection beats a
  // silent stub answer that nudges the test in a misleading
  // direction.

  askApproval(): Promise<"yes" | "no"> {
    return Promise.reject(
      new Error("NullUI does not support askApproval — install an AgentUI"),
    );
  }

  askChoice(): Promise<never> {
    return Promise.reject(
      new Error("NullUI does not support askChoice — install an AgentUI"),
    );
  }

  askText(): Promise<string> {
    return Promise.reject(
      new Error("NullUI does not support askText — install an AgentUI"),
    );
  }

  // ── Paste-buffer drain ─────────────────────────────────────────
  //
  // No readline → no paste buffer to drain. Resolve immediately so
  // headless / test callers can safely invoke `drainPasteBuffer()`
  // around modal prompts without branching on UI implementation.

  async drainPasteBuffer(): Promise<void> {
    /* intentionally empty — non-interactive UI has no paste buffer */
  }
}
