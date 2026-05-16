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
//   - Status spinner: owned internally — `TerminalUI` constructs the
//     `Spinner` at startup and is the sole driver of its lifecycle.
//
// What lives elsewhere
// ────────────────────
//   - Markdown-mode buffering decision — the *caller* decides
//     whether to call `emitText` (streaming) or to buffer and call
//     `renderMarkdown` once at the end. The UI does not own that
//     policy.
//   - Verbose-mode toggling is propagated by the slash-command
//     handler via `setVerboseReasoning`; the UI keeps its internal
//     spinner in sync.
// ────────────────────────────────────────────────────────────────────

import { ANSI, C } from "../ansi.js";
import { renderMarkdown } from "../markdown-renderer.js";
import { formatUsageStats, renderReasoningDelta } from "../llm-output.js";
import { Spinner } from "../spinner.js";
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
    /** No colour — used for audit phase lines which historically print plain. */
    plain: (s) => s,
  };

/** Construction options for `TerminalUI`.
 *
 * The interface is **read live** on every emit — the UI keeps a
 * reference to the object and re-reads the flags on each call, so
 * mutations performed elsewhere (e.g. when the user toggles
 * `/markdown` or `/verbose`) propagate without re-construction.
 *
 * The agent passes its `state` here; tests pass a plain object.
 */
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
  /**
   * When true, strip ANSI **colour / attribute** codes (SGR `\x1b[…m`)
   * from every byte the UI emits. Cursor-control codes (`\r`,
   * `\x1b[2K`, `\x1b[1A`) are preserved so the spinner still clears
   * its lines correctly. Disabled by default.
   */
  readonly noColor?: boolean;
  /**
   * When true, suppress informational notifications (`level === "info"`).
   * Warnings, errors, success and plain notifications still emit.
   * Disabled by default.
   */
  readonly quiet?: boolean;
}

/**
 * Regex matching ANSI SGR (Select Graphic Rendition) sequences —
 * the colour and text-attribute escapes we want `--no-color` to strip.
 * Deliberately narrow: it does **not** match cursor-control sequences
 * (`\x1b[2K`, `\x1b[1A`, etc) so the spinner's line-clearing still
 * works when the user has asked for plain output.
 */
const SGR_REGEX = /\x1b\[[0-9;]*m/g;

/**
 * Terminal-targeted `AgentUI`. Produces the same bytes the existing
 * REPL emits today.
 *
 * State boundaries:
 *   - `_opts` is a *live reference* to the configuration; the agent
 *     passes its `state` here and any mutation (e.g. slash-command
 *     toggles) takes effect immediately on the next emit.
 *   - `_spinner` is owned exclusively by this class — no external
 *     code should construct a `Spinner` directly any more.
 */
export class TerminalUI implements AgentUI {
  // ── Construction ───────────────────────────────────────────────

  /** Internal spinner instance — sole owner of its lifecycle. */
  private readonly _spinner: Spinner;
  /**
   * Live reference to the configuration. Read on every emit, so
   * mutations by slash-commands (e.g. `/markdown off`) propagate
   * automatically — no `setMarkdownEnabled` plumbing required.
   */
  private readonly _opts: TerminalUIOptions;

  /**
   * @param options - Live configuration reference. The object is
   *   *not* copied — the UI re-reads the fields on each emit so
   *   external mutations (e.g. toggles via slash-commands) take
   *   effect immediately. The spinner is constructed internally
   *   using `options.verboseOutput` as the initial verbose flag;
   *   subsequent updates flow via `setVerboseReasoning`.
   */
  constructor(options: TerminalUIOptions) {
    this._opts = options;
    // The spinner's output routes through `this._write` so the same
    // colour-stripping rules apply to both spinner frames and the
    // rest of the UI's emissions.
    this._spinner = new Spinner(options.verboseOutput, (s) => this._write(s));
  }

  // ── Output helpers ─────────────────────────────────────────────

  /**
   * Write a raw chunk to stdout. When `_opts.noColor` is true the
   * SGR colour/attribute codes are stripped before the bytes hit
   * the terminal; cursor-control codes survive so the spinner's
   * line-clearing continues to work.
   */
  private _write(s: string): void {
    process.stdout.write(this._opts.noColor ? s.replace(SGR_REGEX, "") : s);
  }

  /**
   * `console.log`-equivalent that honours `noColor`. Mirrors
   * `console.log`'s trailing-newline behaviour by writing
   * `${line}\n` through `_write`.
   */
  private _log(line: string = ""): void {
    this._write(`${line}\n`);
  }

  // ── Streaming output ───────────────────────────────────────────

  emitText(payload: TextDeltaPayload): void {
    // Unconditionally stop the spinner — first text delta clears it,
    // subsequent deltas are a no-op. Matches `event-handler.ts`'s
    // unconditional `spinner.stop()` *before* the markdown-mode gate.
    // Stopping must happen even when output is suppressed (markdown
    // mode) so the spinner doesn't keep overwriting the (eventually
    // rendered) markdown block when `renderMarkdown` fires later.
    this._spinner.stop();
    // Markdown mode: caller buffers the full text and renders it via
    // `renderMarkdown` once the turn ends. Streaming is suppressed
    // to avoid double-displaying.
    if (this._opts.markdownEnabled) return;
    if (payload.content.length === 0) return;
    this._write(payload.content);
  }

  emitReasoning(payload: ReasoningDeltaPayload): void {
    if (payload.content.length === 0) return;
    renderReasoningDelta(
      this._spinner,
      payload.content,
      this._opts.verboseOutput,
    );
  }

  emitReasoningTransition(payload: ReasoningTransitionPayload): void {
    // Always stop the spinner so the transition (or, in compact
    // mode, the following text) lands on a fresh line. Matches
    // `event-handler.ts`'s unconditional `spinner.stop()` at the
    // top of `assistant.message_delta`.
    this._spinner.stop();

    // Banner mode (used by audit-progress): emit the verbose
    // line-terminator, print the "Reasoning complete" line, reset
    // the spinner clock, and optionally re-start a new activity.
    // Mirrors the original `renderReasoningTransition(spinner,
    // verbose, indent)` helper from `llm-output.ts`.
    if (payload.showBanner) {
      if (this._opts.verboseOutput) {
        this._write(`${ANSI.reset}\n`);
      }
      this._log(`${payload.indent ?? BLOCK_INDENT}✅ Reasoning complete`);
      this._spinner.resetTurnStart();
      if (payload.nextActivity) {
        this._spinner.start(payload.nextActivity);
      }
      return;
    }

    // Compact (event-handler) mode: only verbose produces visible
    // bytes — the next `emitText` carries the first response chunk
    // inline. Matches:
    //   if (state.verboseOutput && hadReasoning && !state.streamedContent)
    //     process.stdout.write(`${ANSI.reset}\n\n`);
    // The caller is responsible for deciding *whether* to emit the
    // transition; here we only own the *how*.
    if (!this._opts.verboseOutput) return;
    this._write(`${ANSI.reset}\n\n`);
  }

  clearReasoningBuffer(): void {
    // Drop any buffered reasoning preview without emitting visible
    // bytes. Used by audit-progress at the reasoning → responding
    // transition where the banner is conditional but the buffer
    // must always be reset.
    this._spinner.clearReasoning();
  }

  hasBufferedReasoning(): boolean {
    // Mirrors the historical `spinner.reasoningLength > 0` check in
    // event-handler.ts. The compact-mode reasoning renderer appends
    // deltas to the spinner's preview buffer; verbose mode prints
    // inline and does not append. Callers (notably the
    // reasoning → response separator emission) rely on the
    // compact-mode-only semantics this getter inherits from
    // `Spinner.reasoningLength`.
    return this._spinner.reasoningLength > 0;
  }

  setVerboseReasoning(value: boolean): void {
    // The `/verbose` slash-command toggles `state.verboseOutput`;
    // the spinner's verbose-reasoning flag is independent storage,
    // so the caller forwards the new value through here. Subsequent
    // render ticks honour the updated flag.
    this._spinner.verboseReasoning = value;
  }

  renderMarkdown(payload: MarkdownPayload): void {
    if (payload.source.length === 0) return;
    this._log(renderMarkdown(payload.source));
  }

  // ── Tool calls ─────────────────────────────────────────────────

  emitToolStart(payload: ToolStartPayload): void {
    // Stop the spinner so the line lands cleanly, then restart with
    // a single space so the user still sees a heartbeat while the
    // tool runs. Matches `event-handler.ts` "tool.execution_start".
    this._spinner.stop();
    this._log(`\n${BLOCK_INDENT}${C.tool(`🔧 ${payload.name}`)}`);
    this._spinner.start(" ");
  }

  emitToolResult(payload: ToolResultPayload): void {
    // Note: deliberately *no* `spinner.stop()` here. The spinner is
    // still running from `emitToolStart`'s `spinner.start(" ")`. The
    // following `console.log` calls land on a fresh line below the
    // spinner; in a live terminal the spinner overwrites itself on
    // the next tick. Matches `event-handler.ts` "tool.execution_complete".
    if (!payload.silent) {
      const icon = TOOL_STATUS_ICON[payload.status];
      const colour = TOOL_STATUS_COLOR[payload.status];
      this._log(`${BLOCK_INDENT}${colour(`${icon} ${payload.message}`)}`);

      // Optional structured body. Phase 2 will exercise the body
      // branches as the verbose-mode tool-result formatter migrates.
      if (payload.body) {
        if (payload.body.kind === "markdown") {
          this._log(renderMarkdown(payload.body.content));
        } else {
          // Both "text" and "json" render dimmed; the caller already
          // pretty-prints JSON before handing it over.
          this._log(C.dim(payload.body.content));
        }
      }

      // Pre-formatted hint (e.g. buffer-overflow suggestion). The
      // caller has already applied colours; print verbatim.
      if (payload.hint) {
        this._log(payload.hint);
      }
    }

    // Trailing blank line then restart the spinner with the new
    // label — the model typically continues right after. If the
    // spinner is already active from `emitToolStart`, `start()`
    // only updates the label (no fresh interval). Runs even in the
    // `silent` branch so the spinner doesn't crash into already-
    // displayed text.
    this._log();
    this._spinner.start("Thinking...");
  }

  // ── Status / activity ──────────────────────────────────────────

  beginTurn(): void {
    // Mark the start of a fresh assistant turn: reset the timer
    // used to display "still working…" affordances and clear any
    // lingering reasoning preview from the previous turn. Visible
    // activity is set separately via `setActivity`.
    this._spinner.resetTurnStart();
    this._spinner.clearReasoning();
  }

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
    this._write(`\x1b]2;HyperAgent: ${payload.title}\x07`);
  }

  // ── Notifications ──────────────────────────────────────────────

  emitNotification(payload: NotificationPayload): void {
    // `quiet` mode suppresses purely informational notifications.
    // Warnings, errors, success and plain (audit phase) lines still
    // emit so the user always sees something went wrong / finished.
    if (this._opts.quiet && payload.level === "info") return;
    // Notifications never appear mid-stream — stop the spinner so
    // the line lands at column 0.
    this._spinner.stop();
    const colour = LEVEL_COLOR[payload.level];
    const prefix = payload.icon ? `${payload.icon} ` : "";
    const indent = payload.indent ?? BLOCK_INDENT;
    this._log(`${indent}${colour(`${prefix}${payload.message}`)}`);
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
      const indent = payload.indent ?? BLOCK_INDENT;
      this._log(`${indent}${C.dim("📊 " + statsStr)}`);
    }
  }
}
