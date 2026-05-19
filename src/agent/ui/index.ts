// ── agent/ui/index.ts — UI port barrel ──────────────────────────────
//
// Single import point for the AgentUI port and its implementations.
// Keep this lean — re-exports only, no side-effects.
// ────────────────────────────────────────────────────────────────────

export type { AgentUI } from "./port.js";
export type {
  ActivityKind,
  ActivityPayload,
  MarkdownPayload,
  NotificationKind,
  NotificationLevel,
  NotificationPayload,
  ReasoningDeltaPayload,
  ReasoningTransitionPayload,
  TextDeltaPayload,
  ToolResultBody,
  ToolResultPayload,
  ToolStartPayload,
  ToolStatus,
  UsagePayload,
  WindowTitlePayload,
} from "./events.js";
export { NullUI } from "./null-ui.js";
export { TerminalUI, type TerminalUIOptions } from "./terminal-ui.js";
export {
  JsonLinesUI,
  JSON_LINES_PROTOCOL_VERSION,
  type JsonLinesUIOptions,
  type JsonLinesWriter,
  type ReadyPayload,
} from "./json-lines-ui.js";
