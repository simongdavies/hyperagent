// ── tests/ui-harness/test-state.ts ──────────────────────────────────
//
// Build an `AgentState` suitable for unit-testing the event handler
// in isolation. We start from the production `createAgentState()`
// factory (so any new fields are picked up automatically) and then
// apply caller-supplied overrides on top.
//
// Defaults are tuned for *deterministic* test output:
//   - `markdownEnabled: false` — streaming text writes raw to stdout
//     (markdown buffers silently which would mask drift in goldens)
//   - `verboseOutput: false`   — compact reasoning preview (the
//     single-line variant the spinner manages)
//   - All token totals 0, no overrides set, no pending state.
// ────────────────────────────────────────────────────────────────────

import { createAgentState, type AgentState } from "../../src/agent/state.js";
import type { CliConfig } from "../../src/agent/cli-parser.js";

/**
 * Minimal `CliConfig` used to seed the production state factory.
 *
 * We pin the model to a fixed string so token-cost calculations
 * (which look up pricing by model name) stay deterministic.
 */
const TEST_CLI: CliConfig = {
  model: "test-model",
  cpuTimeout: "2000",
  wallTimeout: "5000",
  sendTimeout: "60000",
  heapSize: "16",
  scratchSize: "8",
  showCode: false,
  showTiming: false,
  reasoningEffort: "",
  verbose: false,
  veryVerbose: false,
  markdown: false,
  transcript: false,
  listModels: false,
  resumeSession: "",
  pluginsDir: "",
  debug: false,
  tune: false,
  profile: "",
  autoApprove: false,
  baseDir: "",
  prompt: "",
  promptFile: "",
  skill: "",
  skipSuggest: false,
  outputThreshold: "65536",
  showVersion: false,
  noColor: false,
  quiet: false,
  attach: [],
  ipcStdio: false,
};

/**
 * Build a fresh `AgentState` for tests, with optional overrides.
 *
 * Overrides are shallow — provide whole sub-objects (e.g. a new
 * `Set` for `sessionApprovals`) rather than trying to merge into them.
 */
export function makeTestState(overrides: Partial<AgentState> = {}): AgentState {
  const state = createAgentState(TEST_CLI, {
    showCode: false,
    showTiming: false,
  });
  return { ...state, ...overrides };
}
