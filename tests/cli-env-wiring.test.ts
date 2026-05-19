// ── tests/cli-env-wiring.test.ts ─────────────────────────────────────
//
// Asserts that `applyCliEnvOverrides(cli, env)` writes every
// downstream env-var the agent contracts to set. This is the third
// link in the chain:
//
//   argv → CliConfig → AgentState (covered in cli-state-wiring.test.ts)
//          CliConfig → process.env  ← THIS FILE
//
// Tests pass a throwaway env record so the real `process.env` is
// never mutated and the suite stays hermetic.
//
// What's contracted (matches the call site in `src/agent/index.ts`):
//
//   Always-on writes:
//     COPILOT_MODEL                      ← cli.model
//     HYPERLIGHT_CPU_TIMEOUT_MS          ← cli.cpuTimeout
//     HYPERLIGHT_WALL_TIMEOUT_MS         ← cli.wallTimeout
//     HYPERAGENT_SEND_TIMEOUT_MS         ← cli.sendTimeout
//     HYPERLIGHT_HEAP_SIZE_MB            ← cli.heapSize
//     HYPERLIGHT_SCRATCH_SIZE_MB         ← cli.scratchSize
//     HYPERAGENT_OUTPUT_THRESHOLD_BYTES  ← cli.outputThreshold
//     COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES ← cli.outputThreshold
//     COPILOT_LARGE_OUTPUT_MAX_BYTES     ← cli.outputThreshold
//
//   Conditional (only when truthy):
//     HYPERAGENT_VERBOSE ← "1" if cli.verbose
//     HYPERAGENT_DEBUG   ← "1" if cli.debug
//
// ─────────────────────────────────────────────────────────────────────

import { describe, expect, it } from "vitest";

import { applyCliEnvOverrides, parseCliArgs } from "../src/agent/cli-parser.js";

/** Start from a clean env record so every test is hermetic. */
function makeEnv(): NodeJS.ProcessEnv {
  return {};
}

describe("applyCliEnvOverrides — always-on writes", () => {
  it("propagates model + numeric / timeout flags from default CliConfig", () => {
    const env = makeEnv();
    applyCliEnvOverrides(parseCliArgs([]), env);
    // Defaults come from parseCliArgs ([] argv, clean env not asserted —
    // we don't pre-stub HYPERAGENT_*/COPILOT_* env in this suite because
    // CI may have them set). Assert SHAPE: each key is a non-empty string.
    expect(env.COPILOT_MODEL).toBeTypeOf("string");
    expect(env.HYPERLIGHT_CPU_TIMEOUT_MS).toBeTypeOf("string");
    expect(env.HYPERLIGHT_WALL_TIMEOUT_MS).toBeTypeOf("string");
    expect(env.HYPERAGENT_SEND_TIMEOUT_MS).toBeTypeOf("string");
    expect(env.HYPERLIGHT_HEAP_SIZE_MB).toBeTypeOf("string");
    expect(env.HYPERLIGHT_SCRATCH_SIZE_MB).toBeTypeOf("string");
  });

  it("writes the exact CLI values verbatim", () => {
    const env = makeEnv();
    const cli = parseCliArgs([
      "--model",
      "claude-magic",
      "--cpu-timeout",
      "2500",
      "--wall-timeout",
      "10000",
      "--send-timeout",
      "60000",
      "--heap-size",
      "128",
      "--scratch-size",
      "64",
      "--output-threshold",
      "16384",
    ]);
    applyCliEnvOverrides(cli, env);
    expect(env.COPILOT_MODEL).toBe("claude-magic");
    expect(env.HYPERLIGHT_CPU_TIMEOUT_MS).toBe("2500");
    expect(env.HYPERLIGHT_WALL_TIMEOUT_MS).toBe("10000");
    expect(env.HYPERAGENT_SEND_TIMEOUT_MS).toBe("60000");
    expect(env.HYPERLIGHT_HEAP_SIZE_MB).toBe("128");
    expect(env.HYPERLIGHT_SCRATCH_SIZE_MB).toBe("64");
  });

  it("mirrors the output threshold into all three env names", () => {
    const env = makeEnv();
    applyCliEnvOverrides(parseCliArgs(["--output-threshold", "42424"]), env);
    expect(env.HYPERAGENT_OUTPUT_THRESHOLD_BYTES).toBe("42424");
    expect(env.COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES).toBe("42424");
    expect(env.COPILOT_LARGE_OUTPUT_MAX_BYTES).toBe("42424");
  });

  it("overwrites any pre-existing values in the env object", () => {
    const env: NodeJS.ProcessEnv = {
      COPILOT_MODEL: "stale-model",
      HYPERLIGHT_CPU_TIMEOUT_MS: "111",
      HYPERAGENT_OUTPUT_THRESHOLD_BYTES: "777",
    };
    const cli = parseCliArgs([
      "--model",
      "fresh-model",
      "--cpu-timeout",
      "555",
      "--output-threshold",
      "9999",
    ]);
    applyCliEnvOverrides(cli, env);
    expect(env.COPILOT_MODEL).toBe("fresh-model");
    expect(env.HYPERLIGHT_CPU_TIMEOUT_MS).toBe("555");
    expect(env.HYPERAGENT_OUTPUT_THRESHOLD_BYTES).toBe("9999");
  });
});

describe("applyCliEnvOverrides — conditional verbose / debug", () => {
  it("does NOT write HYPERAGENT_VERBOSE when --verbose is absent", () => {
    const env = makeEnv();
    applyCliEnvOverrides(parseCliArgs([]), env);
    expect(env.HYPERAGENT_VERBOSE).toBeUndefined();
  });

  it("writes HYPERAGENT_VERBOSE='1' when --verbose is set", () => {
    const env = makeEnv();
    applyCliEnvOverrides(parseCliArgs(["--verbose"]), env);
    expect(env.HYPERAGENT_VERBOSE).toBe("1");
  });

  it("does NOT write HYPERAGENT_DEBUG when --debug is absent", () => {
    const env = makeEnv();
    applyCliEnvOverrides(parseCliArgs([]), env);
    expect(env.HYPERAGENT_DEBUG).toBeUndefined();
  });

  it("writes HYPERAGENT_DEBUG='1' when --debug is set", () => {
    const env = makeEnv();
    applyCliEnvOverrides(parseCliArgs(["--debug"]), env);
    expect(env.HYPERAGENT_DEBUG).toBe("1");
  });

  it("--verbose + --debug both write env mirrors", () => {
    const env = makeEnv();
    applyCliEnvOverrides(parseCliArgs(["--verbose", "--debug"]), env);
    expect(env.HYPERAGENT_VERBOSE).toBe("1");
    expect(env.HYPERAGENT_DEBUG).toBe("1");
  });

  it("does NOT clear a pre-existing HYPERAGENT_VERBOSE when --verbose absent (env vars persist if user set them)", () => {
    // Rationale: applyCliEnvOverrides is additive, not authoritative.
    // If the operator exported HYPERAGENT_VERBOSE=1 themselves and ran
    // without --verbose, that env value still propagates to the rest
    // of the agent — parseCliArgs already lifted it into cli.verbose
    // anyway, so the net effect is consistent.
    const env: NodeJS.ProcessEnv = { HYPERAGENT_VERBOSE: "1" };
    applyCliEnvOverrides(parseCliArgs([]), env);
    expect(env.HYPERAGENT_VERBOSE).toBe("1");
  });
});

describe("applyCliEnvOverrides — defaults to process.env", () => {
  it("when no env arg is passed, writes to process.env", () => {
    const KEY = "HYPERAGENT_TEST_DEFAULT_PROCESS_ENV";
    // Use a one-off key we can clean up. Reuse COPILOT_MODEL as the
    // observable since the function always writes it.
    const orig = process.env.COPILOT_MODEL;
    try {
      const sentinel = `__test-model-${Date.now()}__`;
      applyCliEnvOverrides(parseCliArgs(["--model", sentinel]));
      expect(process.env.COPILOT_MODEL).toBe(sentinel);
    } finally {
      if (orig === undefined) delete process.env.COPILOT_MODEL;
      else process.env.COPILOT_MODEL = orig;
      // KEY is unused (kept as guidance for future expanded checks).
      void KEY;
    }
  });
});
