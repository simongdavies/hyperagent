// ── tests/cli-state-wiring.test.ts ───────────────────────────────────
//
// Asserts that every CLI flag that has a parallel field on `AgentState`
// is correctly mirrored by `createAgentState(cli, opts)`. This is the
// second link in the chain:
//
//   `argv` ─parseCliArgs→ `CliConfig` ─createAgentState→ `AgentState`
//
// Parser coverage lives in `tests/cli-parser.test.ts`; this file
// guards the parser→state hand-off so a future refactor of either
// side can't silently drop a flag's effect on runtime state.
//
// Env vars are cleared before each test so we only assert on argv
// behaviour, never on the developer's shell environment.
//
// ─────────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseCliArgs } from "../src/agent/cli-parser.js";
import { createAgentState } from "../src/agent/state.js";

const STATE_ENV_VARS = [
  "COPILOT_MODEL",
  "HYPERAGENT_VERBOSE",
  "HYPERAGENT_VERY_VERBOSE",
  "HYPERAGENT_MARKDOWN",
  "HYPERAGENT_NO_COLOR",
  "HYPERAGENT_QUIET",
  "HYPERAGENT_DEBUG",
  "HYPERAGENT_TUNE",
  "HYPERAGENT_AUTO_APPROVE",
  "HYPERAGENT_REASONING_EFFORT",
  "HYPERAGENT_BASE_DIR",
] as const;

const origEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of STATE_ENV_VARS) {
    origEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of STATE_ENV_VARS) {
    if (origEnv[k] === undefined) delete process.env[k];
    else process.env[k] = origEnv[k];
  }
});

/** Common opts arg — these tests only care about CLI→state propagation. */
const DEFAULT_OPTS = { showCode: false, showTiming: false } as const;

describe("createAgentState — CLI → state mirror", () => {
  it("--model sets state.currentModel", () => {
    const cli = parseCliArgs(["--model", "claude-magic"]);
    const state = createAgentState(cli, DEFAULT_OPTS);
    expect(state.currentModel).toBe("claude-magic");
  });

  it("--verbose sets state.verboseOutput=true", () => {
    expect(createAgentState(parseCliArgs([]), DEFAULT_OPTS).verboseOutput).toBe(
      false,
    );
    expect(
      createAgentState(parseCliArgs(["--verbose"]), DEFAULT_OPTS).verboseOutput,
    ).toBe(true);
  });

  it("--no-markdown sets state.markdownEnabled=false (default true)", () => {
    expect(
      createAgentState(parseCliArgs([]), DEFAULT_OPTS).markdownEnabled,
    ).toBe(true);
    expect(
      createAgentState(parseCliArgs(["--no-markdown"]), DEFAULT_OPTS)
        .markdownEnabled,
    ).toBe(false);
    expect(
      createAgentState(parseCliArgs(["--no-md"]), DEFAULT_OPTS).markdownEnabled,
    ).toBe(false);
  });

  it("--no-color sets state.noColor=true", () => {
    expect(createAgentState(parseCliArgs([]), DEFAULT_OPTS).noColor).toBe(
      false,
    );
    expect(
      createAgentState(parseCliArgs(["--no-color"]), DEFAULT_OPTS).noColor,
    ).toBe(true);
  });

  it("--quiet sets state.quiet=true", () => {
    expect(createAgentState(parseCliArgs([]), DEFAULT_OPTS).quiet).toBe(false);
    expect(
      createAgentState(parseCliArgs(["--quiet"]), DEFAULT_OPTS).quiet,
    ).toBe(true);
  });

  it("--debug sets state.debugEnabled=true", () => {
    expect(createAgentState(parseCliArgs([]), DEFAULT_OPTS).debugEnabled).toBe(
      false,
    );
    expect(
      createAgentState(parseCliArgs(["--debug"]), DEFAULT_OPTS).debugEnabled,
    ).toBe(true);
  });

  it("--tune sets state.tuneEnabled=true", () => {
    expect(createAgentState(parseCliArgs([]), DEFAULT_OPTS).tuneEnabled).toBe(
      false,
    );
    expect(
      createAgentState(parseCliArgs(["--tune"]), DEFAULT_OPTS).tuneEnabled,
    ).toBe(true);
  });

  it("--auto-approve / --yolo sets state.autoApprove=true", () => {
    expect(createAgentState(parseCliArgs([]), DEFAULT_OPTS).autoApprove).toBe(
      false,
    );
    expect(
      createAgentState(parseCliArgs(["--auto-approve"]), DEFAULT_OPTS)
        .autoApprove,
    ).toBe(true);
    expect(
      createAgentState(parseCliArgs(["--yolo"]), DEFAULT_OPTS).autoApprove,
    ).toBe(true);
  });

  it("opts.showCode and opts.showTiming propagate independently of CLI", () => {
    // These are derived from sandbox.config in index.ts, not from cli,
    // but the state-mirror contract still applies — they go directly
    // onto state.{showCodeEnabled,showTimingEnabled} for /status etc.
    const cli = parseCliArgs([]);
    const state = createAgentState(cli, { showCode: true, showTiming: true });
    expect(state.showCodeEnabled).toBe(true);
    expect(state.showTimingEnabled).toBe(true);
  });

  it("starts with all resource overrides null (slash-commands populate them)", () => {
    const cli = parseCliArgs(["--cpu-timeout", "1234", "--heap-size", "64"]);
    const state = createAgentState(cli, DEFAULT_OPTS);
    // The CLI numeric flags are propagated via env vars / sandbox
    // config, NOT directly into state. State overrides are slash-
    // command-only at boot; this test pins that contract.
    expect(state.cpuTimeoutOverride).toBeNull();
    expect(state.wallTimeoutOverride).toBeNull();
    expect(state.sendTimeoutOverride).toBeNull();
    expect(state.inputBufferOverride).toBeNull();
    expect(state.outputBufferOverride).toBeNull();
    expect(state.heapOverride).toBeNull();
    expect(state.scratchOverride).toBeNull();
    expect(state.reasoningEffort).toBeNull();
  });
});
