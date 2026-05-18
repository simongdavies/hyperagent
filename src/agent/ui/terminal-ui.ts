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
//   - Reasoning deltas / transition: compact mode feeds the
//     spinner's preview; verbose mode writes inline via `_write`
//     so the bytes flow through `--no-color` stripping and the
//     transcript listener fan-out.

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
import { formatUsageStats } from "../llm-output.js";
import { Spinner } from "../spinner.js";
import type { AgentUI } from "./port.js";
import type {
  ActivityPayload,
  ApprovalQuestion,
  ChoiceAnswer,
  ChoiceQuestion,
  MarkdownPayload,
  NotificationLevel,
  NotificationPayload,
  ReasoningDeltaPayload,
  ReasoningTransitionPayload,
  TextDeltaPayload,
  TextQuestion,
  ToolResultPayload,
  ToolStartPayload,
  ToolStatus,
  UsagePayload,
  WindowTitlePayload,
} from "./events.js";
import type { Interface as ReadlineInterface } from "node:readline/promises";

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
  /**
   * Active readline instance, read **live** on every modal prompt
   * so `/new` and other session swaps that swap the readline take
   * effect without re-constructing the UI. `null`/`undefined` means
   * "no interactive input available" — `ask*` returns a safe
   * default rather than throwing.
   *
   * Optional so the existing host of test sites that pass a minimal
   * options object don't have to grow a `readlineInstance: null`
   * field; production code passes the agent's live `state`, which
   * already carries this field.
   */
  readonly readlineInstance?: ReadlineInterface | null;
  /**
   * Wall-clock timestamp (ms since epoch) of the most recent user
   * input event. Read **live** by `drainPasteBuffer()` so the grace
   * window — "if a paste arrived within the last 500ms, don't drain,
   * those lines are part of the same paste, not stale buffer" — is
   * evaluated against the freshest value at call time.
   *
   * Optional with a sane default (treated as `0` when absent) so
   * test sites that don't exercise the drain path can omit it. The
   * production agent state carries this field at all times.
   */
  readonly lastUserInputTime?: number;
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
 * Secondary sink for everything the `TerminalUI` emits to stdout.
 *
 * Used by the session transcript (and, in future, by any other
 * passive observer that needs to mirror the user-visible output —
 * debug logs, network telemetry, etc.) to subscribe to the stream
 * without monkey-patching `process.stdout.write`.
 *
 * Listeners receive the **post-stripping** bytes: when `--no-color`
 * is active the chunk has already had SGR escapes removed, matching
 * exactly what the user saw on screen.
 */
export interface TerminalOutputListener {
  /** Called with every chunk `TerminalUI` writes to stdout. */
  write(chunk: string): void;
}

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
   * Secondary sinks (transcript recorder, future debug taps) that
   * receive a copy of every chunk written via `_write`. Iteration
   * order is insertion order; failures inside a listener are
   * isolated so the primary stdout write is never lost.
   */
  private readonly _outputListeners = new Set<TerminalOutputListener>();

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
   *
   * After the primary write, every registered `TerminalOutputListener`
   * receives the same (post-stripping) chunk so the on-screen view
   * and the captured transcript stay in sync. A listener that throws
   * is logged via the debug stream — the remaining listeners and
   * the primary write are unaffected.
   */
  private _write(s: string): void {
    const out = this._opts.noColor ? s.replace(SGR_REGEX, "") : s;
    process.stdout.write(out);
    if (this._outputListeners.size === 0) return;
    for (const listener of this._outputListeners) {
      try {
        listener.write(out);
      } catch {
        // A misbehaving listener must never break primary output.
        // We deliberately swallow here — the listener is responsible
        // for routing its own errors to a side-channel if needed.
      }
    }
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
    if (this._opts.verboseOutput) {
      // Verbose mode: stream reasoning inline through the same
      // `_write` chokepoint as every other byte we emit. This way
      // `--no-color` strips the ANSI dim/italic wrappers and any
      // attached `TerminalOutputListener` (transcript, future
      // recorders) sees the reasoning text alongside everything
      // else. Compact mode feeds the spinner preview instead — no
      // stdout write happens in that branch.
      this._spinner.stop();
      this._write(`${ANSI.dim}${ANSI.italic}${payload.content}${ANSI.reset}`);
    } else {
      this._spinner.start("Reasoning...");
      this._spinner.appendReasoning(payload.content);
    }
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

  // ── Secondary output sinks ─────────────────────────────────────

  /**
   * Subscribe a passive listener to the stdout stream.
   *
   * The listener receives every chunk written via the UI's internal
   * `_write` path — `emitText`, `renderMarkdown`, tool lines,
   * notifications, usage stats *and* the spinner frames. The chunk
   * is delivered post-`--no-color` stripping so the listener sees
   * exactly what the user did.
   *
   * @returns an unsubscribe function. Safe to call more than once
   *   and after the UI is no longer in use.
   */
  addOutputListener(listener: TerminalOutputListener): () => void {
    this._outputListeners.add(listener);
    return () => {
      this._outputListeners.delete(listener);
    };
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

  // ── Modal user prompts ─────────────────────────────────────────
  //
  // Every prompt:
  //   1. Stops the spinner so the readline prompt isn't overwritten
  //      by a spinner tick.
  //   2. Renders the question through `_log` so `--no-color` and the
  //      transcript listener fan-out both apply.
  //   3. Reads `readlineInstance` *live* off `_opts` — handles the
  //      case where `/new` (or a future session swap) installs a
  //      fresh readline mid-session.
  //   4. Falls back to a sensible default when no readline is
  //      available rather than throwing — the caller's hook
  //      contract (e.g. SDK `onUserInputRequest`) expects a string
  //      to come back, never a rejection.
  //
  // Auto-approve short-circuiting belongs in the **caller** (see
  // `user-input-handler.ts`) — keeping it out of the UI means the
  // contract here is purely "ask the user; return their answer".

  async askApproval(payload: ApprovalQuestion): Promise<"yes" | "no"> {
    this._spinner.stop();
    const rl = this._opts.readlineInstance;
    const defaultChoice = payload.defaultChoice ?? "no";
    // `[Y/n]` when default is yes; `[y/N]` when default is no — the
    // capitalised letter signals which Enter will pick.
    const hint = defaultChoice === "yes" ? "[Y/n]" : "[y/N]";
    this._log(`\n  ${C.info("❓")} ${payload.question} ${C.dim(hint)}`);
    if (!rl) {
      // No interactive input — return the default. The caller can
      // log a debug breadcrumb if it cares.
      return defaultChoice;
    }
    const raw = await rl.question(`     ${C.dim("> ")}`);
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === "") return defaultChoice;
    if (trimmed === "y" || trimmed === "yes") return "yes";
    if (trimmed === "n" || trimmed === "no") return "no";
    // Unrecognised input falls back to the default — matches today's
    // ad-hoc `[y/n]` prompts in slash-commands.ts which treat any
    // non-"y" answer as "no".
    return defaultChoice;
  }

  async askChoice(payload: ChoiceQuestion): Promise<ChoiceAnswer> {
    this._spinner.stop();
    const rl = this._opts.readlineInstance;
    const allowFreeform = payload.allowFreeform !== false;
    this._log(`\n  ${C.info("❓")} ${payload.question}`);
    for (let i = 0; i < payload.choices.length; i++) {
      this._log(`     ${C.info(`[${i + 1}]`)} ${payload.choices[i]}`);
    }
    if (allowFreeform) {
      this._log(`     ${C.dim("Or type a custom answer")}`);
    }
    if (!rl) {
      // No interactive input — default to the first choice.
      return { answer: payload.choices[0] ?? "", wasFreeform: false };
    }
    const raw = await rl.question(`     ${C.dim("Choice: ")}`);
    const trimmed = raw.trim();
    const pick = parseInt(trimmed, 10);
    if (pick >= 1 && pick <= payload.choices.length) {
      return { answer: payload.choices[pick - 1], wasFreeform: false };
    }
    if (trimmed && allowFreeform) {
      return { answer: trimmed, wasFreeform: true };
    }
    // Empty input *or* invalid input with freeform disabled → first
    // choice as the default. Matches today's user-input-handler.ts
    // behaviour byte-for-byte.
    return { answer: payload.choices[0] ?? "", wasFreeform: false };
  }

  async askText(payload: TextQuestion): Promise<string> {
    this._spinner.stop();
    const rl = this._opts.readlineInstance;
    this._log(`\n  ${C.info("❓")} ${payload.question}`);
    if (!rl) {
      // No interactive input — return empty string and let the
      // caller decide how to surface "no answer".
      return "";
    }
    const raw = await rl.question(`     ${C.dim("> ")}`);
    return raw.trim();
  }

  /**
   * Inline freeform prompt — renders the caller-supplied prompt
   * verbatim through readline (no styled question block) and
   * returns the trimmed reply. Used by form-style flows
   * (plugin-config) that pre-format each field as a single line.
   *
   * The readline `question(prompt)` call writes the prompt straight
   * to stdout — unlike `_log` it does NOT pass through the
   * `--no-color` SGR-stripping pipeline. Callers are expected to
   * pass an already-uncoloured prompt for form-style fields, which
   * matches today's plugin-config bytes. The trade-off is documented
   * in the port-level JSDoc on `askInline`.
   */
  async askInline(prompt: string): Promise<string> {
    this._spinner.stop();
    const rl = this._opts.readlineInstance;
    if (!rl) {
      // No interactive input — return empty string and let the
      // caller decide how to surface "no answer".
      return "";
    }
    const raw = await rl.question(prompt);
    return raw.trim();
  }

  // ── Paste-buffer drain ─────────────────────────────────────────

  /**
   * Drain any buffered paste lines and warn the user if content was
   * discarded. Called immediately before critical prompts so a
   * stale paste tail can't accidentally answer them.
   *
   * Honours a grace window driven by `_opts.lastUserInputTime`: if
   * the user typed in the last `DRAIN_GRACE_MS`, the buffered
   * content is assumed to be the tail of the *same* paste they just
   * submitted — not stale content from a prior turn — so draining
   * is skipped to avoid eating valid input.
   *
   * The warning bytes flow through `_write` so they share the
   * SGR-stripping path that `--no-color` uses, and so the
   * transcript recorder mirrors them like any other UI output.
   */
  async drainPasteBuffer(): Promise<void> {
    const rl = this._opts.readlineInstance;
    if (!rl) {
      // No readline → nothing to drain. Treat as a successful no-op.
      return;
    }
    // Skip if user input arrived too recently — those buffered lines
    // are almost certainly the tail of the current paste, not stale.
    const lastInput = this._opts.lastUserInputTime ?? 0;
    if (Date.now() - lastInput < TerminalUI.DRAIN_GRACE_MS) {
      return;
    }

    const discarded = await TerminalUI._drainBufferedLines(rl);
    if (discarded.length === 0) return;

    this._log(
      C.warn(
        "⚠️  Discarded " + discarded.length + " buffered line(s) from paste:",
      ),
    );
    for (const line of discarded.slice(0, TerminalUI.DRAIN_PREVIEW_COUNT)) {
      const truncated =
        line.length > TerminalUI.DRAIN_PREVIEW_LEN
          ? line.slice(0, TerminalUI.DRAIN_PREVIEW_LEN) + "..."
          : line;
      this._log(C.dim('     "' + truncated + '"'));
    }
    if (discarded.length > TerminalUI.DRAIN_PREVIEW_COUNT) {
      this._log(
        C.dim(
          "     ...and " +
            (discarded.length - TerminalUI.DRAIN_PREVIEW_COUNT) +
            " more",
        ),
      );
    }
  }

  /**
   * Grace window: if user input was received within this many
   * milliseconds, skip the drain entirely. The buffered lines are
   * almost certainly the tail of the *current* paste, not stale
   * content from a previous turn.
   */
  private static readonly DRAIN_GRACE_MS = 500;

  /**
   * Quiet period after the last buffered `line` event before we
   * declare the drain complete. 80ms is empirically long enough to
   * absorb a multi-line paste while not delaying the next prompt.
   */
  private static readonly DRAIN_QUIET_MS = 80;

  /** How many discarded lines to preview in the warning. */
  private static readonly DRAIN_PREVIEW_COUNT = 2;

  /** Max characters from each previewed line. */
  private static readonly DRAIN_PREVIEW_LEN = 50;

  /**
   * Drain any buffered lines from a paste. Returns the discarded
   * content so the caller can surface it as a warning. Pure helper
   * — no logging, no state mutation outside readline's own buffer.
   *
   * Mechanics:
   *   1. Steal the partial line currently sitting in readline's
   *      internal `.line` buffer (the not-yet-newline-terminated
   *      tail of the paste).
   *   2. Subscribe to `line` events for a short quiet period and
   *      collect any further whole lines the buffer flushes.
   *   3. Resolve once the buffer has been quiet for
   *      `DRAIN_QUIET_MS` — readline emits buffered lines lazily
   *      so we need at least one tick to see what's there.
   */
  private static async _drainBufferedLines(
    rl: ReadlineInterface,
  ): Promise<string[]> {
    const discarded: string[] = [];

    // (1) Steal any partial line — readline holds the not-yet-newline-
    // terminated tail of the paste in its internal `line` buffer.
    const internal = rl as unknown as { line: string; cursor: number };
    if (internal.line && internal.line.trim()) {
      discarded.push(internal.line);
      internal.line = "";
      internal.cursor = 0;
    }

    // (2) Subscribe to `line` events for a brief quiet period and
    // collect any further buffered whole lines.
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;

      const handler = (line: string) => {
        if (line.trim()) {
          discarded.push(line);
        }
        // Reset the quiet timer — more lines may still arrive.
        clearTimeout(timer);
        timer = setTimeout(finish, TerminalUI.DRAIN_QUIET_MS);
      };

      const finish = () => {
        rl.off("line", handler);
        resolve(discarded);
      };

      rl.on("line", handler);
      // Initial timer — if no lines arrive at all we resolve cleanly.
      timer = setTimeout(finish, TerminalUI.DRAIN_QUIET_MS);
    });
  }
}
