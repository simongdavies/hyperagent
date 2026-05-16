// ── agent/ui/terminal-ui.ts — concrete AgentUI for the CLI ──────────
//
// Wraps the existing terminal output pipeline (ANSI colours, the
// `Spinner` instance, the markdown renderer, the usage-stats helper)
// behind the `AgentUI` interface. The bytes produced here are
// **byte-for-byte identical** to what `event-handler.ts` produces
// today — that invariant is the safety net that lets Phase 2
// migrate the handler without changing the golden outputs.
//
// Where the rendering lives
// ─────────────────────────
//   - Streaming text: direct `process.stdout.write` (preserves the
//     no-buffering live-typing effect; markdown mode is a no-op
//     here — the caller renders the full message via
//     `renderMarkdown()` once the turn ends).
//   - Reasoning deltas / transition: delegated to
//     `llm-output.renderReasoningDelta`, identical to today's path.
//   - Tool start / result lines: matches today's
//     `console.log(\`  \${C.<icon>(\`<emoji> <msg>\`)}\`)` shape.
//   - Status spinner: forwarded to the existing `Spinner` instance
//     passed in via the constructor.
//
// What lives elsewhere
// ────────────────────
//   - Markdown-mode buffering decision — the *caller* decides
//     whether to call `emitText` (streaming) or to buffer and call
//     `renderMarkdown` once at the end. The UI does not own that
//     policy.
//   - Spinner ownership today is shared with non-UI code paths
//     (audit-progress, slash-commands). Phase 4 absorbs the spinner
//     fully; for now we hold a reference.
// ────────────────────────────────────────────────────────────────────

import { ANSI, C } from "../ansi.js";
import { renderMarkdown } from "../markdown-renderer.js";
import {
  formatUsageStats,
  printUsageStats,
  renderReasoningDelta,
} from "../llm-output.js";
import type { Spinner } from "../spinner.js";
import type { AgentUI } from "./port.js";
import type {
  ActivityPayload,
  MarkdownPayload,
  NotificationLevel,
  NotificationPayload,
  ReasoningDeltaPayload,
  ReasoningTransitionPayload,
  TextDeltaPayload,
  ToolResultPayload,
  ToolStartPayload,
  ToolStatus,
  UsagePayload,
  WindowTitlePayload,
} from "./events.js";

/**
 * Indent used in front of every block line (tool calls, notifications,
 * usage stats, etc). Mirrors today's hard-coded `"  "` everywhere in
 * `event-handler.ts`.
 */
const BLOCK_INDENT = "  ";

/** Icon glyph for each tool-call status. */
const TOOL_STATUS_ICON: Readonly<Record<ToolStatus, string>> = {
  success: "✅",
  error: "❌",
  denied: "🚫",
};

/** ANSI colourer for each tool-call status. */
const TOOL_STATUS_COLOR: Readonly<Record<ToolStatus, (s: string) => string>> = {
  success: C.ok,
  error: C.err,
  denied: C.warn,
};

/** ANSI colourer for each notification severity level. */
const LEVEL_COLOR: Readonly<Record<NotificationLevel, (s: string) => string>> =
  {
    info: C.dim,
    warning: C.warn,
    error: C.err,
    success: C.ok,
  };

/** Construction options for `TerminalUI`. */
export interface TerminalUIOptions {
  /**
   * When true, streaming `emitText` is suppressed — the caller is
   * expected to buffer content and call `renderMarkdown()` at the
   * end of the turn. Mirrors today's `state.markdownEnabled` flag.
   */
  readonly markdownEnabled: boolean;
  /**
   * When true, verbose-mode behaviour is selected for reasoning
   * deltas (scroll inline) and the reasoning → response separator.
   * Mirrors today's `state.verboseOutput`.
   */
  readonly verboseOutput: boolean;
}

/**
 * Terminal-targeted `AgentUI`. Produces the same bytes the existing
 * REPL emits today.
 *
 * State boundaries:
 *   - `_opts` is the *only* mutable display configuration. Update
 *     via `setMarkdownEnabled` / `setVerboseOutput` if the user
 *     toggles modes mid-session.
 *   - All other state lives in the injected `Spinner` instance or
 *     downstream renderers — nothing else is kept here.
 */
export class TerminalUI implements AgentUI {
  // ── Construction ───────────────────────────────────────────────

  /** Shared spinner instance, currently owned by the caller. */
  private readonly _spinner: Spinner;
  /** Mutable copy of the construction options. */
  private _opts: TerminalUIOptions;

  /**
   * @param spinner - The spinner this UI drives. Phase 4 will absorb
   *   spinner ownership into the UI; today it is shared with
   *   audit-progress and slash-commands.
   * @param options - Display configuration. The values are copied —
   *   later changes to the original object are not observed.
   */
  constructor(spinner: Spinner, options: TerminalUIOptions) {
    this._spinner = spinner;
    this._opts = { ...options };
  }

  // ── Configuration setters ──────────────────────────────────────

  /** Toggle markdown-buffered mode at runtime. */
  setMarkdownEnabled(enabled: boolean): void {
    this._opts = { ...this._opts, markdownEnabled: enabled };
  }

  /** Toggle verbose output at runtime. */
  setVerboseOutput(verbose: boolean): void {
    this._opts = { ...this._opts, verboseOutput: verbose };
  }

  // ── Streaming output ───────────────────────────────────────────

  emitText(payload: TextDeltaPayload): void {
    // Markdown mode: caller buffers the full text and renders it via
    // `renderMarkdown` once the turn ends. Streaming is suppressed
    // to avoid double-displaying.
    if (this._opts.markdownEnabled) return;
    if (payload.content.length === 0) return;
    // Idempotent — first text delta clears the spinner; subsequent
    // deltas are a no-op. Matches `event-handler.ts`'s
    // unconditional `spinner.stop()` before each delta write.
    this._spinner.stop();
    process.stdout.write(payload.content);
  }

  emitReasoning(payload: ReasoningDeltaPayload): void {
    if (payload.content.length === 0) return;
    renderReasoningDelta(
      this._spinner,
      payload.content,
      this._opts.verboseOutput,
    );
  }

  emitReasoningTransition(_payload: ReasoningTransitionPayload): void {
    // Only verbose mode produces visible bytes for the transition —
    // compact mode keeps the spinner alive and silently switches
    // labels via `setActivity`. Matches `event-handler.ts`:
    //   if (state.verboseOutput && hadReasoning && !state.streamedContent)
    //     process.stdout.write(`${ANSI.reset}\n\n`);
    // The caller is responsible for deciding *whether* to emit the
    // transition; here we only own the *how*.
    if (!this._opts.verboseOutput) return;
    process.stdout.write(`${ANSI.reset}\n\n`);
  }

  renderMarkdown(payload: MarkdownPayload): void {
    if (payload.source.length === 0) return;
    console.log(renderMarkdown(payload.source));
  }

  // ── Tool calls ─────────────────────────────────────────────────

  emitToolStart(payload: ToolStartPayload): void {
    // Stop the spinner so the line lands cleanly, then restart with
    // a single space so the user still sees a heartbeat while the
    // tool runs. Matches `event-handler.ts` "tool.execution_start".
    this._spinner.stop();
    console.log(`\n${BLOCK_INDENT}${C.tool(`🔧 ${payload.name}`)}`);
    this._spinner.start(" ");
  }

  emitToolResult(payload: ToolResultPayload): void {
    // Note: deliberately *no* `spinner.stop()` here. The spinner is
    // still running from `emitToolStart`'s `spinner.start(" ")`. The
    // following `console.log` calls land on a fresh line below the
    // spinner; in a live terminal the spinner overwrites itself on
    // the next tick. Matches `event-handler.ts` "tool.execution_complete".
    const icon = TOOL_STATUS_ICON[payload.status];
    const colour = TOOL_STATUS_COLOR[payload.status];
    console.log(`${BLOCK_INDENT}${colour(`${icon} ${payload.message}`)}`);

    // Optional structured body. Phase 2 will exercise the body
    // branches as the verbose-mode tool-result formatter migrates.
    if (payload.body) {
      if (payload.body.kind === "markdown") {
        console.log(renderMarkdown(payload.body.content));
      } else {
        // Both "text" and "json" render dimmed; the caller already
        // pretty-prints JSON before handing it over.
        console.log(C.dim(payload.body.content));
      }
    }

    // Trailing blank line then restart the spinner with the new
    // label — the model typically continues right after. If the
    // spinner is already active from `emitToolStart`, `start()`
    // only updates the label (no fresh interval).
    console.log();
    this._spinner.start("Thinking...");
  }

  // ── Status / activity ──────────────────────────────────────────

  setActivity(payload: ActivityPayload | null): void {
    if (payload === null) {
      this._spinner.stop();
      return;
    }
    // `Spinner.start` doubles as "update label if already running".
    // Pass the activity's `label` straight through — callers build
    // it to match today's strings ("Thinking...", "Planning: …", etc).
    this._spinner.start(payload.label);
  }

  setWindowTitle(payload: WindowTitlePayload): void {
    // OSC escape — sets the terminal window title. The "HyperAgent:"
    // prefix is product branding owned by the terminal UI; other UI
    // implementations choose their own framing.
    process.stdout.write(`\x1b]2;HyperAgent: ${payload.title}\x07`);
  }

  // ── Notifications ──────────────────────────────────────────────

  emitNotification(payload: NotificationPayload): void {
    // Notifications never appear mid-stream — stop the spinner so
    // the line lands at column 0.
    this._spinner.stop();
    const colour = LEVEL_COLOR[payload.level];
    const prefix = payload.icon ? `${payload.icon} ` : "";
    console.log(`${BLOCK_INDENT}${colour(`${prefix}${payload.message}`)}`);
  }

  // ── Usage stats ────────────────────────────────────────────────

  emitUsage(payload: UsagePayload): void {
    this._spinner.stop();
    // The caller has already accumulated session totals; we just
    // render the per-call line.
    //
    // `formatUsageStats` takes the SDK-shaped `UsageData` (with a
    // `duration` field) while our payload uses `durationMs`. Map
    // before delegating.
    const statsStr = formatUsageStats({
      model: payload.model,
      inputTokens: payload.inputTokens,
      outputTokens: payload.outputTokens,
      cacheReadTokens: payload.cacheReadTokens,
      cacheWriteTokens: payload.cacheWriteTokens,
      cost: payload.cost,
      duration: payload.durationMs,
    });
    if (statsStr) {
      printUsageStats(statsStr, BLOCK_INDENT);
    }
  }
}
