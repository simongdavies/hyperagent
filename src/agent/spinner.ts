// ── Spinner ──────────────────────────────────────────────────────────
//
// Braille activity spinner with optional reasoning preview line.
// Encapsulates the 7 mutable variables that were previously module-
// level `let`s in agent.ts. All spinner state lives here.
//
// Two display modes:
//   Compact (default): Line 1 is the spinning frame + label + elapsed.
//                      Line 2 is a single overwriting reasoning preview.
//   Verbose:           Reasoning deltas scroll freely through the
//                      terminal — the spinner suppresses line 2.
//
// ─────────────────────────────────────────────────────────────────────

import { ANSI } from "./ansi.js";

/** Spinner frame characters — classic Braille spinner. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** How quickly the spinner animates (ms per frame). */
const SPINNER_INTERVAL_MS = 80;

/** Max width for the reasoning preview line (truncated beyond this). */
const REASONING_LINE_WIDTH = 76;

/**
 * A terminal activity spinner with optional reasoning preview.
 *
 * Replaces the 7 module-level `let` variables that previously
 * managed spinner state in agent.ts. Each instance is independent.
 *
 * Usage:
 *   const spinner = new Spinner(false);
 *   spinner.start("Thinking...");
 *   spinner.updateLabel("Running tool...");
 *   spinner.stop();
 */
export class Spinner {
  // ── Private state ──────────────────────────────────────────────

  /** Interval ID for the active spinner, or null. */
  private intervalId: ReturnType<typeof setInterval> | null = null;

  /** Current frame index for the spinner animation. */
  private frame = 0;

  /** Current status label displayed beside the spinner frame. */
  private label = "Thinking...";

  /** Timestamp when the current turn started (for elapsed counter). */
  private turnStart: number | null = null;

  /** Accumulated reasoning text from assistant.reasoning_delta events. */
  private reasoningText = "";

  /** Whether the spinner is currently rendering a second (reasoning) line. */
  private hasSecondLine = false;

  /**
   * Verbose reasoning mode — when true, reasoning deltas scroll freely
   * through the terminal instead of overwriting a single preview line.
   */
  private _verboseReasoning: boolean;

  // ── Constructor ────────────────────────────────────────────────

  /**
   * @param verboseReasoning - Initial verbose reasoning mode.
   *   When true, reasoning deltas scroll freely. When false (default),
   *   a single overwriting preview line shows beneath the spinner.
   */
  constructor(verboseReasoning = false) {
    this._verboseReasoning = verboseReasoning;
  }

  // ── Public API — verboseReasoning getter/setter ────────────────

  /** Whether verbose reasoning mode is enabled. */
  get verboseReasoning(): boolean {
    return this._verboseReasoning;
  }

  set verboseReasoning(value: boolean) {
    this._verboseReasoning = value;
  }

  // ── Public API — turn / reasoning state ────────────────────────

  /**
   * Reset the turn-start timestamp to now.
   * Called at the start of each agent turn and on audit-progress events
   * so the elapsed counter tracks the current activity, not a stale turn.
   */
  resetTurnStart(): void {
    this.turnStart = Date.now();
  }

  /**
   * Clear accumulated reasoning text.
   * Called at the start of each turn to reset the preview.
   * If the spinner is showing a second line, stop and restart
   * to properly clear both lines first.
   */
  clearReasoning(): void {
    if (this.hasSecondLine && this.intervalId) {
      // Stop clears both lines and resets hasSecondLine
      const savedLabel = this.label;
      this.stop();
      this.reasoningText = "";
      this.start(savedLabel);
    } else {
      this.reasoningText = "";
    }
  }

  /**
   * Append a reasoning delta to the accumulated text.
   * @param delta - The new reasoning text chunk from the model.
   */
  appendReasoning(delta: string): void {
    this.reasoningText += delta;
  }

  /** Length of the accumulated reasoning text (for separator checks). */
  get reasoningLength(): number {
    return this.reasoningText.length;
  }

  // ── Public API — start / stop / updateLabel ────────────────────

  /**
   * Start the activity spinner with an optional status label.
   * Safe to call if already spinning — updates the label only.
   *
   * If the spinner has a second line (reasoning preview) and we're
   * restarting with a new label, stop first to properly clear both
   * lines before rendering with the new state.
   */
  start(label?: string): void {
    if (label) this.label = label;
    if (this.intervalId) return; // Already spinning — label updated above
    this.frame = 0;
    this.intervalId = setInterval(() => this.render(), SPINNER_INTERVAL_MS);
  }

  /**
   * Update the status label on a running spinner.
   * If the spinner isn't active this is a no-op — the label will be
   * picked up on the next start() call.
   */
  updateLabel(label: string): void {
    this.label = label;
  }

  /**
   * Stop the activity spinner, clearing all spinner lines.
   * Safe to call if not spinning — it's a no-op.
   * Resets the label and reasoning text for the next spin cycle.
   */
  stop(): void {
    if (!this.intervalId) return;
    clearInterval(this.intervalId);
    this.intervalId = null;

    if (this.hasSecondLine) {
      // Clear line 2 (cursor is on it), move up, clear line 1
      process.stdout.write(
        `\r\x1b[2K` + // clear line 2
          `\x1b[1A` + // move up
          `\r\x1b[2K`, // clear line 1
      );
      this.hasSecondLine = false;
    } else {
      // Single line mode — clear the one line
      process.stdout.write("\r\x1b[2K");
    }

    // Reset state for next cycle
    this.label = "Thinking...";
    this.reasoningText = "";
  }

  // ── Private ────────────────────────────────────────────────────

  /**
   * Render the spinner frame — called on each interval tick.
   * Writes line 1 (spinner + label + elapsed) and, when reasoning
   * is visible, line 2 (reasoning preview) that overwrites in place.
   */
  private render(): void {
    const frame = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length];

    // Elapsed time suffix — e.g. " (3s)"
    let elapsed = "";
    if (this.turnStart !== null) {
      const secs = Math.floor((Date.now() - this.turnStart) / 1000);
      if (secs > 0) elapsed = ` (${secs}s)`;
    }

    // Reasoning char count — gives the user a heartbeat even when
    // the preview line is off, so they know the model is still alive.
    let reasoningCount = "";
    if (this.reasoningText.length > 0) {
      const chars = this.reasoningText.length;
      const display =
        chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : String(chars);
      reasoningCount = ` · ${display} chars`;
    }

    // Line 1: spinner frame + label + elapsed + optional reasoning count
    // ESC hint — subtle reminder that the user can cancel.

    const escHint = `  ${ANSI.reset}${ANSI.dim}[ESC cancels]${ANSI.reset}`;
    const line1 = `  ${ANSI.dim}${frame} ${this.label}${elapsed}${reasoningCount}${ANSI.reset}${escHint}`;

    // Line 2: reasoning preview (compact mode — overwriting single line).
    // In verbose mode, reasoning is printed directly in the delta handler,
    // so we skip the preview line here to avoid double-display.
    const showLine2 = !this._verboseReasoning && this.reasoningText.length > 0;

    if (showLine2) {
      // Take the last chunk of reasoning text, strip newlines, truncate.
      // We show the TAIL so the user sees the most recent thought.
      const cleaned = this.reasoningText.replace(/\n/g, " ").trimEnd();
      const tail =
        cleaned.length > REASONING_LINE_WIDTH
          ? "…" + cleaned.slice(-(REASONING_LINE_WIDTH - 1))
          : cleaned;
      const line2 = `  ${ANSI.dim}${ANSI.italic}💭 ${tail}${ANSI.reset}`;

      if (this.hasSecondLine) {
        // Already have two lines — move cursor up, clear both, rewrite
        process.stdout.write(
          `\x1b[1A` + // move up one line
            `\r\x1b[2K` + // clear line 1
            line1 +
            `\n` +
            `\x1b[2K` + // clear line 2
            line2,
        );
      } else {
        // First time showing line 2 — write line 1 + newline + line 2
        process.stdout.write(`\r\x1b[2K${line1}\n${line2}`);
        this.hasSecondLine = true;
      }
    } else {
      // Single line mode.
      if (this.hasSecondLine) {
        // Transitioning from 2 lines to 1 — cursor is on line 2.
        // Clear line 2, move up, clear line 1, write new content.
        process.stdout.write(
          `\r\x1b[2K` + // clear line 2 (where cursor is)
            `\x1b[1A` + // move up to line 1
            `\r\x1b[2K` + // clear line 1
            line1,
        );
        this.hasSecondLine = false;
      } else {
        // Already single line — just overwrite
        process.stdout.write(`\r\x1b[2K${line1}`);
      }
    }

    this.frame++;
  }
}
