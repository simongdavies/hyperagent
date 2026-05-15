// ── tests/ui-harness/index.ts ───────────────────────────────────────
//
// Barrel re-export for the UI capture harness. Test files import
// from here so the internal split between modules can change
// without breaking call sites.
// ────────────────────────────────────────────────────────────────────

export { ansiToSemantic } from "./ansi-to-semantic.js";
export { captureStdio, type StdioCapture } from "./capture-stdio.js";
export { FakeSession } from "./fake-session.js";
export { makeTestState } from "./test-state.js";
export { makeEventFactory, type EventFactory } from "./event-factory.js";
export {
  runEventScript,
  type EventScriptResult,
  type RunEventScriptOptions,
} from "./run-event-script.js";
