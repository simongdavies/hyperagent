// ── agent/ui/events.ts — AgentUI event payloads ─────────────────────
//
// Plain-data types describing every visible side-effect the agent
// can produce. The `AgentUI` port (see `./port.ts`) takes these
// payloads and renders them; the SDK event handler is responsible
// for translating raw `SessionEvent`s into these UI-layer payloads.
//
// Design rules
// ────────────
//   1. **JSON-serialisable only.** No functions, classes, dates, or
//      regex. The same payload must be capable of crossing an IPC
//      boundary (Electron) or being printed as JSON Lines.
//   2. **Stable shape.** These are part of the agent's external
//      contract once `JsonLinesUI` ships. Add fields cautiously.
//   3. **No pre-rendered ANSI.** Carry semantic information; let
//      each UI implementation decide presentation (terminal renders
//      colours, Electron renders DOM, JsonLines renders JSON).
//   4. **Optional fields use `?:`, not `null`.** Reduces wire noise
//      and makes JSON output cleaner.
// ────────────────────────────────────────────────────────────────────

// ── Streaming text payloads ──────────────────────────────────────────

/** Chunk of assistant text streamed to the user. */
export interface TextDeltaPayload {
  /** Raw text content of this chunk. May span multiple lines. */
  readonly content: string;
}

/** Chunk of model reasoning streamed to the user. */
export interface ReasoningDeltaPayload {
  /** Raw reasoning text. May span multiple lines. */
  readonly content: string;
}

// ── Tool invocation payloads ─────────────────────────────────────────

/** A tool call has started executing. */
export interface ToolStartPayload {
  /** The tool's registered name (e.g. `execute_javascript`). */
  readonly name: string;
  /** Correlation id provided by the SDK; matches the completion event. */
  readonly callId: string;
}

/** Outcome status for a completed tool call. */
export type ToolStatus = "success" | "error" | "denied";

/**
 * Display body for a tool result. Lets the UI choose whether to
 * pretty-print JSON, render as markdown, or just show plain text.
 */
export interface ToolResultBody {
  /** How the `content` should be rendered. */
  readonly kind: "text" | "json" | "markdown";
  /** The body string (JSON or markdown source, etc.). */
  readonly content: string;
}

/** A tool call has finished. */
export interface ToolResultPayload {
  /** The tool's registered name. */
  readonly name: string;
  /** Correlation id matching the start event. */
  readonly callId: string;
  /** Overall outcome. */
  readonly status: ToolStatus;
  /**
   * Short single-line message (e.g. "Done", "ReferenceError: x", or
   * "Tool denied by policy"). Always present.
   */
  readonly message: string;
  /**
   * Optional detail body. Sandbox tools attach their result/output
   * here; non-sandbox tools usually omit it.
   */
  readonly body?: ToolResultBody;
}

// ── Activity / spinner payloads ──────────────────────────────────────

/**
 * Hint for what the agent is *doing* during a long-running phase.
 * Drives the terminal spinner label; an Electron UI might map these
 * to icons or status pills. `"custom"` covers ad-hoc labels (e.g.
 * audit-progress detail strings) that don't fit a known bucket.
 */
export type ActivityKind =
  | "thinking"
  | "planning"
  | "reasoning"
  | "tool"
  | "compacting"
  | "waiting"
  | "nudging"
  | "custom";

/** What the agent is doing right now. `null` means "nothing — clear status". */
export interface ActivityPayload {
  /** High-level category for UIs that group activity. */
  readonly kind: ActivityKind;
  /** Short human-readable label, e.g. "Thinking…", "Planning: …". */
  readonly label: string;
  /**
   * Optional second-line detail. Today the terminal uses this for
   * the reasoning preview; future UIs may show it as a subtitle.
   */
  readonly detail?: string;
}

// ── Notifications (info / warning / error / success) ────────────────

/** Severity level for a one-shot notification line. */
export type NotificationLevel = "info" | "warning" | "error" | "success";

/**
 * Semantic tag identifying *what kind* of notification this is.
 * Lets UIs route specific events (e.g. context-compaction) to
 * dedicated affordances rather than rendering as a generic line.
 *
 * Open-ended on purpose; unknown kinds fall through to the level's
 * default styling.
 */
export type NotificationKind =
  | "generic"
  | "keep_alive_nudge"
  | "context_compacted"
  | "context_compaction_failed"
  | "context_truncated"
  | "context_usage"
  | "task_complete"
  | "model_change"
  | "session_resume"
  | "session_stats"
  | "sdk_warning"
  | "sdk_info"
  | "sdk_error"
  | "buffer_overflow_hint";

/** Generic notification — covers info / warning / error / success lines. */
export interface NotificationPayload {
  /** Severity for default styling. */
  readonly level: NotificationLevel;
  /** Semantic tag for richer UIs; defaults to "generic". */
  readonly kind: NotificationKind;
  /**
   * Optional emoji or short prefix. Today's terminal uses things
   * like `⚠️`, `✅`, `📦`, `📊`. Carried separately so JSON
   * consumers can omit it.
   */
  readonly icon?: string;
  /** The message text. */
  readonly message: string;
}

// ── Usage stats payload ──────────────────────────────────────────────

/** Token / cost stats reported by the SDK after each model call. */
export interface UsagePayload {
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  /** Premium request count (not a wall-clock cost). */
  readonly cost?: number;
  /** Wall-clock duration of the API round-trip in ms. */
  readonly durationMs?: number;
}

// ── Markdown rendering payload ───────────────────────────────────────

/**
 * Final assistant message — emitted by the event handler when the
 * model has finished a turn. Carries **raw markdown source**; the
 * terminal UI renders it with the in-house renderer, while a GUI UI
 * can produce HTML or its own AST.
 */
export interface MarkdownPayload {
  /** Raw markdown source. */
  readonly source: string;
}

// ── Window title payload ─────────────────────────────────────────────

/** Set the terminal / window title. */
export interface WindowTitlePayload {
  /** Title text *without* the "HyperAgent: " prefix (UI adds branding). */
  readonly title: string;
}

// ── Reasoning → response transition ──────────────────────────────────

/**
 * Signals the end of the reasoning phase and the start of the visible
 * response. Today the terminal only acts on this when verbose
 * reasoning is enabled (it emits a blank-line separator). Other UIs
 * may use it to switch panels or close a "thinking" affordance.
 */
export type ReasoningTransitionPayload = Record<string, never>;
