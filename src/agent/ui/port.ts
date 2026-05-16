// ── agent/ui/port.ts — AgentUI interface ─────────────────────────────
//
// The `AgentUI` port is the agent's sole channel for visible output
// and modal user prompts. Today's `TerminalUI` mirrors the existing
// CLI behaviour byte-for-byte; a future `JsonLinesUI` serialises the
// same calls to NDJSON for embedding (Electron, headless drivers,
// IDE hosts).
//
// Migration roadmap (see /memories/session/plan.md)
// ─────────────────────────────────────────────────
//   Phase 1 (this PR): define the port + ship `TerminalUI` and
//     `NullUI`. No call sites change — Phase 2 migrates them.
//   Phase 2: `event-handler.ts` calls `ui.emit*` instead of
//     `console.log` / `process.stdout.write`. Goldens guard drift.
//   Phase 3: modal `ask*` methods absorb readline ownership.
//   Phase 4: markdown and spinner rendering become implementation
//     details of `TerminalUI`.
//
// Design rules
// ────────────
//   1. **Emit methods never throw.** A misbehaving UI cannot crash
//      the agent loop.
//   2. **Payloads are plain data** (see `./events.ts`). Methods take
//      typed payload objects rather than positional args so callers
//      remain readable when fields are added.
//   3. **State is owned by the UI**, not the caller. Spinner ticks,
//      streaming buffers, and ANSI bookkeeping live inside the
//      implementation — never leak to the caller.
//   4. **The port is emit-only for now.** Modal `ask*` methods are
//      defined in Phase 3 alongside the readline refactor.
// ────────────────────────────────────────────────────────────────────

import type {
  ActivityPayload,
  MarkdownPayload,
  NotificationPayload,
  ReasoningDeltaPayload,
  ReasoningTransitionPayload,
  TextDeltaPayload,
  ToolResultPayload,
  ToolStartPayload,
  UsagePayload,
  WindowTitlePayload,
} from "./events.js";

/**
 * Surface the agent uses to talk to the user.
 *
 * Implementations:
 *   - `TerminalUI` (`./terminal-ui.ts`) — ANSI to stdout, spinner,
 *     today's interactive REPL experience.
 *   - `NullUI` (`./null-ui.ts`) — no-op; used in unit tests of
 *     business logic that doesn't care about output.
 *   - `JsonLinesUI` (future) — NDJSON to stdout for embedding.
 */
export interface AgentUI {
  // ── Streaming output ───────────────────────────────────────────

  /**
   * A chunk of streamed assistant text. Called many times per turn
   * — implementations must be cheap (no per-chunk parsing, etc.).
   *
   * In markdown mode the terminal UI buffers silently and rendering
   * happens via `renderMarkdown()` once the turn ends.
   */
  emitText(payload: TextDeltaPayload): void;

  /**
   * A chunk of streamed model reasoning. Implementations decide
   * whether to scroll inline (verbose) or feed a single-line preview
   * (compact). Called many times per turn — must be cheap.
   */
  emitReasoning(payload: ReasoningDeltaPayload): void;

  /**
   * Reasoning phase has ended; the visible response is about to
   * begin. Lets the UI insert a separator or close a thinking
   * affordance. Callers may emit this once per turn or not at all.
   */
  emitReasoningTransition(payload: ReasoningTransitionPayload): void;

  /**
   * Drop any buffered reasoning preview state held by the UI. Used
   * by progress callbacks at phase transitions where no banner is
   * needed but the next visible line must not be polluted by the
   * dangling reasoning preview. No-op when there is no buffer.
   */
  clearReasoningBuffer(): void;

  /**
   * Whether the UI is currently holding a non-empty buffered
   * reasoning preview. Callers use this to decide whether to emit a
   * reasoning → response separator before the next visible chunk.
   * Implementations without an internal preview return `false`.
   */
  hasBufferedReasoning(): boolean;

  /**
   * Propagate a verbose-reasoning toggle into the UI. Called by the
   * `/verbose` slash-command after mutating the shared state flag.
   * Implementations that do not render reasoning differently may
   * ignore this entirely. The terminal UI forwards the new value
   * into its internal `Spinner` so the next render tick picks it up.
   */
  setVerboseReasoning(value: boolean): void;

  /**
   * Render a complete assistant message as markdown. Today only
   * called after streaming finishes when markdown mode is on.
   */
  renderMarkdown(payload: MarkdownPayload): void;

  // ── Tool calls ─────────────────────────────────────────────────

  /** A tool has begun executing. */
  emitToolStart(payload: ToolStartPayload): void;

  /** A tool has finished (success, error, or denial). */
  emitToolResult(payload: ToolResultPayload): void;

  // ── Status / activity ──────────────────────────────────────────

  /**
   * Mark the start of an assistant turn. Implementations should
   * reset any per-turn bookkeeping (turn-start timer, buffered
   * reasoning preview, etc). Visible activity is set separately via
   * `setActivity`.
   */
  beginTurn(): void;

  /**
   * Set or clear the current activity indicator. The terminal UI
   * starts/stops/relabels the spinner; GUI UIs may show a status
   * pill or progress bar. `null` clears the indicator.
   */
  setActivity(payload: ActivityPayload | null): void;

  /**
   * Update the window / terminal title. Implementations free to
   * ignore (e.g. JsonLinesUI). Title is the bare name; UI adds
   * any branding prefix.
   */
  setWindowTitle(payload: WindowTitlePayload): void;

  // ── Notifications ──────────────────────────────────────────────

  /**
   * Generic single-line notification (info / warning / error /
   * success). Carries a semantic `kind` so structured UIs can route
   * by event type rather than parsing message strings.
   */
  emitNotification(payload: NotificationPayload): void;

  // ── Usage stats ────────────────────────────────────────────────

  /**
   * Token / cost / duration stats from the SDK after each API call.
   * Implementations decide whether to surface (verbose) or suppress.
   */
  emitUsage(payload: UsagePayload): void;
}
