// ── tests/cli-parser.test.ts ─────────────────────────────────────────
//
// Exhaustive parse-time coverage for every CLI option exposed by
// `parseCliArgs(argv)`. The goal is twofold:
//
//   1. Catch silent regressions where a flag is added/renamed/removed
//      in `cli-parser.ts` but no consumer notices because the value
//      lives in a `CliConfig` field that nothing else asserts on.
//
//   2. Guard the documented contract that CLI flags override env
//      vars, which in turn override hardcoded defaults — the
//      precedence rule advertised in `--help` and the README.
//
// What this file does NOT cover (lives elsewhere):
//   * `--tune`, `--profile`, `--mcp-*`, `--no-color`, `--quiet`,
//     `--ipc-stdio` — see `tests/tune.test.ts`.
//   * `--attach` — see `tests/attach-flag.test.ts`.
//   * Wiring of parsed values through to `state` or env — see
//     `tests/cli-state-wiring.test.ts` and `tests/cli-env-wiring.test.ts`.
//
// Also covers the breaking-change flag cleanup (cli/breaking-flag-cleanup
// PR #167):
//   - `--reasoning-effort` (renamed from `--show-reasoning`)
//   - `--very-verbose` / `-vv` (new)
//   - `--base-dir` / `HYPERAGENT_BASE_DIR` (new)
//   - rejection of the removed `--show-reasoning` flag
//   - `--yolo` alias for `--auto-approve`
// ─────────────────────────────────────────────────────────────────────

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCliArgs } from "../src/agent/cli-parser.js";

/**
 * Capture-and-throw shim for `process.exit` so a parser fast-fail
 * can be asserted against without taking down the test runner. Tests
 * call this once and use `expect(() => parseCliArgs(...)).toThrow()`
 * to assert the exit path was hit.
 *
 * Pairs with a `console.error` spy so we can also inspect the
 * error message the parser wrote before exiting.
 */
function installExitShim(): {
  exit: MockInstance<(code?: number) => never>;
  err: MockInstance<(...args: unknown[]) => void>;
  restore: () => void;
} {
  const origExit = process.exit;
  const origError = console.error;
  const exit = vi.fn((_code?: number): never => {
    throw new Error("__exit__");
  }) as unknown as MockInstance<(code?: number) => never>;
  const err = vi.fn() as unknown as MockInstance<(...args: unknown[]) => void>;
  process.exit = exit as unknown as typeof process.exit;
  console.error = err as unknown as typeof console.error;
  return {
    exit,
    err,
    restore: () => {
      process.exit = origExit;
      console.error = origError;
    },
  };
}

/** Snapshot + clear every env var the parser reads, restored in afterEach. */
const PARSER_ENV_VARS = [
  "COPILOT_MODEL",
  "HYPERLIGHT_CPU_TIMEOUT_MS",
  "HYPERLIGHT_WALL_TIMEOUT_MS",
  "HYPERAGENT_SEND_TIMEOUT_MS",
  "HYPERLIGHT_HEAP_SIZE_MB",
  "HYPERLIGHT_SCRATCH_SIZE_MB",
  "HYPERAGENT_REASONING_EFFORT",
  "HYPERAGENT_SHOW_REASONING",
  "HYPERAGENT_VERBOSE",
  "HYPERAGENT_VERY_VERBOSE",
  "HYPERAGENT_MARKDOWN",
  "HYPERAGENT_TRANSCRIPT",
  "HYPERAGENT_LIST_MODELS",
  "HYPERAGENT_RESUME_SESSION",
  "HYPERAGENT_PLUGINS_DIR",
  "HYPERAGENT_DEBUG",
  "HYPERAGENT_TUNE",
  "HYPERAGENT_PROFILE",
  "HYPERAGENT_AUTO_APPROVE",
  "HYPERAGENT_BASE_DIR",
  "HYPERAGENT_PROMPT",
  "HYPERAGENT_PROMPT_FILE",
  "HYPERAGENT_SKILL",
  "HYPERAGENT_SKIP_SUGGEST",
  "HYPERAGENT_OUTPUT_THRESHOLD_BYTES",
  "HYPERAGENT_NO_COLOR",
  "HYPERAGENT_QUIET",
  "HYPERAGENT_IPC_STDIO",
] as const;

const origEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of PARSER_ENV_VARS) {
    origEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of PARSER_ENV_VARS) {
    if (origEnv[k] === undefined) delete process.env[k];
    else process.env[k] = origEnv[k];
  }
  vi.restoreAllMocks();
});

// ── Defaults ────────────────────────────────────────────────────────

describe("parseCliArgs — defaults", () => {
  it("returns the documented default config when no argv / no env", () => {
    const cli = parseCliArgs([]);
    expect(cli).toMatchObject({
      model: "claude-opus-4.6",
      cpuTimeout: "1000",
      wallTimeout: "5000",
      sendTimeout: "300000",
      heapSize: "16",
      scratchSize: "16",
      showCode: false,
      showTiming: false,
      reasoningEffort: "",
      verbose: false,
      veryVerbose: false,
      markdown: true, // env-derived default — true unless HYPERAGENT_MARKDOWN=0
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
      outputThreshold: "20480",
      showVersion: false,
      noColor: false,
      quiet: false,
      attach: [],
      ipcStdio: false,
    });
    expect(cli.mcpSetupCommand).toBeUndefined();
  });
});

// ── Numeric / string-value flags ────────────────────────────────────

describe("parseCliArgs — string-value flags", () => {
  it("--model sets cli.model and overrides COPILOT_MODEL", () => {
    process.env.COPILOT_MODEL = "gpt-foo";
    expect(parseCliArgs([]).model).toBe("gpt-foo");
    expect(parseCliArgs(["--model", "claude-bar"]).model).toBe("claude-bar");
  });

  it("--cpu-timeout sets cli.cpuTimeout and overrides env", () => {
    process.env.HYPERLIGHT_CPU_TIMEOUT_MS = "1234";
    expect(parseCliArgs([]).cpuTimeout).toBe("1234");
    expect(parseCliArgs(["--cpu-timeout", "9999"]).cpuTimeout).toBe("9999");
  });

  it("--wall-timeout sets cli.wallTimeout and overrides env", () => {
    process.env.HYPERLIGHT_WALL_TIMEOUT_MS = "55";
    expect(parseCliArgs([]).wallTimeout).toBe("55");
    expect(parseCliArgs(["--wall-timeout", "77"]).wallTimeout).toBe("77");
  });

  it("--send-timeout sets cli.sendTimeout and overrides env", () => {
    process.env.HYPERAGENT_SEND_TIMEOUT_MS = "12345";
    expect(parseCliArgs([]).sendTimeout).toBe("12345");
    expect(parseCliArgs(["--send-timeout", "99999"]).sendTimeout).toBe("99999");
  });

  it("--heap-size sets cli.heapSize and overrides env", () => {
    process.env.HYPERLIGHT_HEAP_SIZE_MB = "32";
    expect(parseCliArgs([]).heapSize).toBe("32");
    expect(parseCliArgs(["--heap-size", "128"]).heapSize).toBe("128");
  });

  it("--scratch-size sets cli.scratchSize and overrides env", () => {
    process.env.HYPERLIGHT_SCRATCH_SIZE_MB = "64";
    expect(parseCliArgs([]).scratchSize).toBe("64");
    expect(parseCliArgs(["--scratch-size", "256"]).scratchSize).toBe("256");
  });

  it("--plugins-dir sets cli.pluginsDir and overrides env", () => {
    process.env.HYPERAGENT_PLUGINS_DIR = "/env/plugins";
    expect(parseCliArgs([]).pluginsDir).toBe("/env/plugins");
    expect(parseCliArgs(["--plugins-dir", "/cli/plugins"]).pluginsDir).toBe(
      "/cli/plugins",
    );
  });

  it("--output-threshold sets cli.outputThreshold and overrides env", () => {
    process.env.HYPERAGENT_OUTPUT_THRESHOLD_BYTES = "8192";
    expect(parseCliArgs([]).outputThreshold).toBe("8192");
    expect(parseCliArgs(["--output-threshold", "65536"]).outputThreshold).toBe(
      "65536",
    );
  });

  it("--prompt sets cli.prompt and overrides env", () => {
    process.env.HYPERAGENT_PROMPT = "from env";
    expect(parseCliArgs([]).prompt).toBe("from env");
    expect(parseCliArgs(["--prompt", "from cli"]).prompt).toBe("from cli");
  });

  it("--skill sets cli.skill (single name or space-separated list)", () => {
    process.env.HYPERAGENT_SKILL = "from-env";
    expect(parseCliArgs([]).skill).toBe("from-env");
    expect(parseCliArgs(["--skill", "pptx-expert"]).skill).toBe("pptx-expert");
    expect(parseCliArgs(["--skill", "skill-a skill-b"]).skill).toBe(
      "skill-a skill-b",
    );
  });
});

// ── Missing-value error paths ───────────────────────────────────────

describe("parseCliArgs — flags that require a value error on missing arg", () => {
  const VALUE_FLAGS: ReadonlyArray<{ flag: string; errMatch: RegExp }> = [
    { flag: "--model", errMatch: /--model requires a value/ },
    { flag: "--cpu-timeout", errMatch: /--cpu-timeout requires a value/ },
    { flag: "--wall-timeout", errMatch: /--wall-timeout requires a value/ },
    { flag: "--send-timeout", errMatch: /--send-timeout requires a value/ },
    { flag: "--heap-size", errMatch: /--heap-size requires a value/ },
    { flag: "--scratch-size", errMatch: /--scratch-size requires a value/ },
    { flag: "--plugins-dir", errMatch: /--plugins-dir requires a value/ },
    { flag: "--profile", errMatch: /--profile requires a value/ },
    { flag: "--prompt", errMatch: /--prompt requires a value/ },
    { flag: "--prompt-file", errMatch: /--prompt-file requires a value/ },
    { flag: "--skill", errMatch: /--skill requires a value/ },
    {
      flag: "--output-threshold",
      errMatch: /--output-threshold requires a value/,
    },
    { flag: "--attach", errMatch: /--attach requires a file path/ },
  ];

  for (const { flag, errMatch } of VALUE_FLAGS) {
    it(`${flag} (no value) prints error and exits 1`, () => {
      const shim = installExitShim();
      try {
        expect(() => parseCliArgs([flag])).toThrow("__exit__");
        expect(shim.exit).toHaveBeenCalledWith(1);
        expect(String(shim.err.mock.calls[0]?.[0] ?? "")).toMatch(errMatch);
      } finally {
        shim.restore();
      }
    });
  }
});

// ── Boolean toggles ─────────────────────────────────────────────────

describe("parseCliArgs — boolean toggles", () => {
  it("--show-code → showCode=true (no env var)", () => {
    expect(parseCliArgs([]).showCode).toBe(false);
    expect(parseCliArgs(["--show-code"]).showCode).toBe(true);
  });

  it("--show-timing → showTiming=true (no env var)", () => {
    expect(parseCliArgs([]).showTiming).toBe(false);
    expect(parseCliArgs(["--show-timing"]).showTiming).toBe(true);
  });

  it("--verbose → verbose=true (and HYPERAGENT_VERBOSE=1 picks up default)", () => {
    expect(parseCliArgs([]).verbose).toBe(false);
    expect(parseCliArgs(["--verbose"]).verbose).toBe(true);
    process.env.HYPERAGENT_VERBOSE = "1";
    expect(parseCliArgs([]).verbose).toBe(true);
    // CLI flag overrides env var (even when env value is "0")
    process.env.HYPERAGENT_VERBOSE = "0";
    expect(parseCliArgs([]).verbose).toBe(false);
    expect(parseCliArgs(["--verbose"]).verbose).toBe(true);
  });

  it("--debug → debug=true (and HYPERAGENT_DEBUG=1)", () => {
    expect(parseCliArgs([]).debug).toBe(false);
    expect(parseCliArgs(["--debug"]).debug).toBe(true);
    process.env.HYPERAGENT_DEBUG = "1";
    expect(parseCliArgs([]).debug).toBe(true);
  });

  it("--transcript → transcript=true (and HYPERAGENT_TRANSCRIPT=1)", () => {
    expect(parseCliArgs([]).transcript).toBe(false);
    expect(parseCliArgs(["--transcript"]).transcript).toBe(true);
    process.env.HYPERAGENT_TRANSCRIPT = "1";
    expect(parseCliArgs([]).transcript).toBe(true);
  });

  it("--list-models → listModels=true (and HYPERAGENT_LIST_MODELS=1)", () => {
    expect(parseCliArgs([]).listModels).toBe(false);
    expect(parseCliArgs(["--list-models"]).listModels).toBe(true);
    process.env.HYPERAGENT_LIST_MODELS = "1";
    expect(parseCliArgs([]).listModels).toBe(true);
  });

  it("--auto-approve → autoApprove=true (and HYPERAGENT_AUTO_APPROVE=1)", () => {
    expect(parseCliArgs([]).autoApprove).toBe(false);
    expect(parseCliArgs(["--auto-approve"]).autoApprove).toBe(true);
    process.env.HYPERAGENT_AUTO_APPROVE = "1";
    expect(parseCliArgs([]).autoApprove).toBe(true);
  });

  it("--yolo → autoApprove=true (alias for --auto-approve)", () => {
    expect(parseCliArgs(["--yolo"]).autoApprove).toBe(true);
  });

  it("--skip-suggest → skipSuggest=true (and HYPERAGENT_SKIP_SUGGEST=1)", () => {
    expect(parseCliArgs([]).skipSuggest).toBe(false);
    expect(parseCliArgs(["--skip-suggest"]).skipSuggest).toBe(true);
    process.env.HYPERAGENT_SKIP_SUGGEST = "1";
    expect(parseCliArgs([]).skipSuggest).toBe(true);
  });

  it("--version / -v → showVersion=true (no env var)", () => {
    expect(parseCliArgs([]).showVersion).toBe(false);
    expect(parseCliArgs(["--version"]).showVersion).toBe(true);
    expect(parseCliArgs(["-v"]).showVersion).toBe(true);
  });
});

// ── Markdown (tri-state with env var) ───────────────────────────────

describe("parseCliArgs — --markdown / --no-markdown", () => {
  it("defaults markdown=true", () => {
    expect(parseCliArgs([]).markdown).toBe(true);
  });

  it("--no-markdown / --no-md → markdown=false", () => {
    expect(parseCliArgs(["--no-markdown"]).markdown).toBe(false);
    expect(parseCliArgs(["--no-md"]).markdown).toBe(false);
  });

  it("--markdown / --md → markdown=true (explicit override of env)", () => {
    process.env.HYPERAGENT_MARKDOWN = "0";
    expect(parseCliArgs([]).markdown).toBe(false);
    expect(parseCliArgs(["--markdown"]).markdown).toBe(true);
    expect(parseCliArgs(["--md"]).markdown).toBe(true);
  });

  it("HYPERAGENT_MARKDOWN=0 disables (any other value enables)", () => {
    process.env.HYPERAGENT_MARKDOWN = "0";
    expect(parseCliArgs([]).markdown).toBe(false);
    process.env.HYPERAGENT_MARKDOWN = "1";
    expect(parseCliArgs([]).markdown).toBe(true);
    process.env.HYPERAGENT_MARKDOWN = "anything-else";
    expect(parseCliArgs([]).markdown).toBe(true);
  });

  it("last-wins when CLI mixes --markdown and --no-markdown", () => {
    expect(parseCliArgs(["--markdown", "--no-markdown"]).markdown).toBe(false);
    expect(parseCliArgs(["--no-markdown", "--markdown"]).markdown).toBe(true);
  });
});

// ── --reasoning-effort (replaces removed --show-reasoning) ─────────

describe("parseCliArgs — --reasoning-effort", () => {
  it("defaults to empty when not given (env nor flag)", () => {
    expect(parseCliArgs([]).reasoningEffort).toBe("");
  });

  it("defaults to 'high' when flag given without a level", () => {
    expect(parseCliArgs(["--reasoning-effort"]).reasoningEffort).toBe("high");
  });

  it("accepts low/medium/high/xhigh (case-insensitive)", () => {
    for (const level of ["low", "medium", "high", "xhigh"]) {
      expect(parseCliArgs(["--reasoning-effort", level]).reasoningEffort).toBe(
        level,
      );
      expect(
        parseCliArgs(["--reasoning-effort", level.toUpperCase()])
          .reasoningEffort,
      ).toBe(level);
    }
  });

  it("falls back to 'high' when the next arg is not a valid level", () => {
    // Next token is treated as belonging to a later flag; parser
    // defaults the effort to 'high' and does NOT consume the token.
    const cfg = parseCliArgs(["--reasoning-effort", "--verbose"]);
    expect(cfg.reasoningEffort).toBe("high");
    expect(cfg.verbose).toBe(true);
  });

  it("reads HYPERAGENT_REASONING_EFFORT env var", () => {
    process.env.HYPERAGENT_REASONING_EFFORT = "medium";
    expect(parseCliArgs([]).reasoningEffort).toBe("medium");
  });

  it("CLI flag overrides env var", () => {
    process.env.HYPERAGENT_REASONING_EFFORT = "low";
    expect(parseCliArgs(["--reasoning-effort", "xhigh"]).reasoningEffort).toBe(
      "xhigh",
    );
  });

  it("HYPERAGENT_REASONING_EFFORT with an invalid value falls back to ''", () => {
    // Regression: an unexpected env value (e.g. typo, leftover from an
    // older flag schema) must NOT propagate verbatim to the SDK union
    // type — it should be treated as unset so the SDK falls back to its
    // default reasoning level instead of throwing at session-config time.
    process.env.HYPERAGENT_REASONING_EFFORT = "potato";
    expect(parseCliArgs([]).reasoningEffort).toBe("");
  });

  it("HYPERAGENT_REASONING_EFFORT is case-normalised (HIGH → high)", () => {
    // Symmetry with the CLI flag handler which lowercases its argument.
    process.env.HYPERAGENT_REASONING_EFFORT = "HIGH";
    expect(parseCliArgs([]).reasoningEffort).toBe("high");
  });
});

// ── --show-reasoning is REMOVED (hard break) ────────────────────────

describe("parseCliArgs — --show-reasoning (removed)", () => {
  it("rejects --show-reasoning with 'Unknown option' and exits", () => {
    const shim = installExitShim();
    try {
      expect(() => parseCliArgs(["--show-reasoning"])).toThrow("__exit__");
      expect(shim.exit).toHaveBeenCalledWith(1);
      expect(String(shim.err.mock.calls[0]?.[0] ?? "")).toMatch(
        /Unknown option: --show-reasoning/,
      );
    } finally {
      shim.restore();
    }
  });

  it("ignores HYPERAGENT_SHOW_REASONING (old env var is dead)", () => {
    // The old env var should not be wired anywhere. Setting it must not
    // affect reasoningEffort.
    process.env.HYPERAGENT_SHOW_REASONING = "xhigh";
    expect(parseCliArgs([]).reasoningEffort).toBe("");
  });
});

// ── --very-verbose / -vv ────────────────────────────────────────────

describe("parseCliArgs — --very-verbose / -vv", () => {
  it("defaults to false when not given", () => {
    const cfg = parseCliArgs([]);
    expect(cfg.veryVerbose).toBe(false);
    expect(cfg.verbose).toBe(false);
  });

  it("--very-verbose sets BOTH verbose AND veryVerbose", () => {
    const cfg = parseCliArgs(["--very-verbose"]);
    expect(cfg.verbose).toBe(true);
    expect(cfg.veryVerbose).toBe(true);
  });

  it("-vv is equivalent to --very-verbose", () => {
    const cfg = parseCliArgs(["-vv"]);
    expect(cfg.verbose).toBe(true);
    expect(cfg.veryVerbose).toBe(true);
  });

  it("--verbose on its own does NOT enable veryVerbose", () => {
    const cfg = parseCliArgs(["--verbose"]);
    expect(cfg.verbose).toBe(true);
    expect(cfg.veryVerbose).toBe(false);
  });

  it("HYPERAGENT_VERY_VERBOSE=1 enables veryVerbose (env)", () => {
    process.env.HYPERAGENT_VERY_VERBOSE = "1";
    const cfg = parseCliArgs([]);
    expect(cfg.veryVerbose).toBe(true);
  });

  it("HYPERAGENT_VERY_VERBOSE=1 ALSO enables verbose (env-path symmetry)", () => {
    // Regression: without this, env-var-only very-verbose would set
    // veryVerbose=true but verbose=false, and the event-handler gate
    // (`verboseOutput && (isSandbox || veryVerbose)`) would silently
    // suppress all tool bodies — defeating the whole flag.
    process.env.HYPERAGENT_VERY_VERBOSE = "1";
    delete process.env.HYPERAGENT_VERBOSE;
    const cfg = parseCliArgs([]);
    expect(cfg.verbose).toBe(true);
    expect(cfg.veryVerbose).toBe(true);
  });

  it("HYPERAGENT_VERY_VERBOSE=0 leaves veryVerbose false", () => {
    process.env.HYPERAGENT_VERY_VERBOSE = "0";
    const cfg = parseCliArgs([]);
    expect(cfg.veryVerbose).toBe(false);
  });
});

// ── --base-dir ──────────────────────────────────────────────────────

describe("parseCliArgs — --base-dir", () => {
  it("defaults to empty string when not given", () => {
    expect(parseCliArgs([]).baseDir).toBe("");
  });

  it("accepts a path argument", () => {
    expect(parseCliArgs(["--base-dir", "/tmp/sandbox"]).baseDir).toBe(
      "/tmp/sandbox",
    );
  });

  it("preserves the raw value (no resolution at parse-time)", () => {
    // Path resolution happens in index.ts after parse — keep the parser
    // pure so it can be unit-tested without filesystem context.
    expect(parseCliArgs(["--base-dir", "./relative/path"]).baseDir).toBe(
      "./relative/path",
    );
  });

  it("exits when --base-dir has no value", () => {
    const shim = installExitShim();
    try {
      expect(() => parseCliArgs(["--base-dir"])).toThrow("__exit__");
      expect(shim.exit).toHaveBeenCalledWith(1);
      expect(String(shim.err.mock.calls[0]?.[0] ?? "")).toBe(
        "--base-dir requires a non-empty path",
      );
    } finally {
      shim.restore();
    }
  });

  it("rejects whitespace-only --base-dir value with exit", () => {
    // Regression: `--base-dir "   "` was previously truthy and let
    // `index.ts` call `resolve("".trim())` → `process.cwd()`, silently
    // making CWD the sandbox root. Parser must trim+reject at the boundary.
    const shim = installExitShim();
    try {
      expect(() => parseCliArgs(["--base-dir", "   "])).toThrow("__exit__");
      expect(shim.exit).toHaveBeenCalledWith(1);
      expect(String(shim.err.mock.calls[0]?.[0] ?? "")).toBe(
        "--base-dir requires a non-empty path",
      );
    } finally {
      shim.restore();
    }
  });

  it("trims whitespace around --base-dir value", () => {
    // Tabs / spaces around the path are stripped — keeps the parser
    // forgiving for shell-mangled args while still rejecting empty.
    expect(parseCliArgs(["--base-dir", "  /tmp/foo  "]).baseDir).toBe(
      "/tmp/foo",
    );
  });

  it("reads HYPERAGENT_BASE_DIR env var", () => {
    process.env.HYPERAGENT_BASE_DIR = "/var/data";
    expect(parseCliArgs([]).baseDir).toBe("/var/data");
  });

  it("treats whitespace-only HYPERAGENT_BASE_DIR as unset", () => {
    // Symmetry with the CLI flag: env-var path must also trim and treat
    // an empty-after-trim string as missing rather than letting it flow
    // into `resolve("".trim())` → `process.cwd()`.
    process.env.HYPERAGENT_BASE_DIR = "   ";
    expect(parseCliArgs([]).baseDir).toBe("");
  });

  it("CLI flag overrides env var", () => {
    process.env.HYPERAGENT_BASE_DIR = "/from/env";
    expect(parseCliArgs(["--base-dir", "/from/cli"]).baseDir).toBe("/from/cli");
  });

  it("--yolo does NOT auto-enable --base-dir (the two flags are independent)", () => {
    const cfg = parseCliArgs(["--yolo"]);
    expect(cfg.autoApprove).toBe(true);
    expect(cfg.baseDir).toBe("");
  });
});

// ── Optional-argument flags ─────────────────────────────────────────

describe("parseCliArgs — --resume (optional argument)", () => {
  it("--resume with no argument sets sentinel '__last__'", () => {
    expect(parseCliArgs(["--resume"]).resumeSession).toBe("__last__");
  });

  it("--resume <id> captures the session id", () => {
    expect(parseCliArgs(["--resume", "session-abc"]).resumeSession).toBe(
      "session-abc",
    );
  });

  it("--resume followed by another flag treats as no-arg form", () => {
    const cli = parseCliArgs(["--resume", "--debug"]);
    expect(cli.resumeSession).toBe("__last__");
    expect(cli.debug).toBe(true);
  });

  it("HYPERAGENT_RESUME_SESSION populates the default", () => {
    process.env.HYPERAGENT_RESUME_SESSION = "sess-from-env";
    expect(parseCliArgs([]).resumeSession).toBe("sess-from-env");
  });
});

// ── --prompt-file: reads from disk into cli.prompt ──────────────────

describe("parseCliArgs — --prompt-file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hyperagent-prompt-file-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the file content into cli.prompt (trimmed)", () => {
    const p = join(dir, "prompt.txt");
    writeFileSync(p, "  hello from a file  \n\n");
    const cli = parseCliArgs(["--prompt-file", p]);
    expect(cli.promptFile).toBe(p);
    expect(cli.prompt).toBe("hello from a file");
  });

  it("--prompt wins over --prompt-file when both are supplied", () => {
    const p = join(dir, "prompt.txt");
    writeFileSync(p, "from-file");
    const cli = parseCliArgs(["--prompt-file", p, "--prompt", "from-cli-arg"]);
    expect(cli.prompt).toBe("from-cli-arg");
  });

  it("missing --prompt-file path exits with a helpful error", () => {
    const shim = installExitShim();
    try {
      expect(() =>
        parseCliArgs(["--prompt-file", join(dir, "does-not-exist.txt")]),
      ).toThrow("__exit__");
      expect(shim.exit).toHaveBeenCalledWith(1);
      expect(String(shim.err.mock.calls[0]?.[0] ?? "")).toMatch(
        /Failed to read prompt file/,
      );
    } finally {
      shim.restore();
    }
  });

  it("HYPERAGENT_PROMPT_FILE populates the default and is read", () => {
    const p = join(dir, "env-prompt.txt");
    writeFileSync(p, "from env-file");
    process.env.HYPERAGENT_PROMPT_FILE = p;
    const cli = parseCliArgs([]);
    expect(cli.promptFile).toBe(p);
    expect(cli.prompt).toBe("from env-file");
  });
});

// ── Aliases & terminator-style flags ────────────────────────────────

describe("parseCliArgs — aliases & exit-style flags", () => {
  it("--help / -h prints usage and exits 0", () => {
    const origLog = console.log;
    console.log = vi.fn();
    const shim = installExitShim();
    try {
      expect(() => parseCliArgs(["--help"])).toThrow("__exit__");
      expect(shim.exit).toHaveBeenCalledWith(0);
      expect(() => parseCliArgs(["-h"])).toThrow("__exit__");
    } finally {
      shim.restore();
      console.log = origLog;
    }
  });

  it("unknown option prints error and exits 1", () => {
    const shim = installExitShim();
    try {
      expect(() => parseCliArgs(["--definitely-not-a-flag"])).toThrow(
        "__exit__",
      );
      expect(shim.exit).toHaveBeenCalledWith(1);
      expect(String(shim.err.mock.calls[0]?.[0] ?? "")).toMatch(
        /Unknown option: --definitely-not-a-flag/,
      );
    } finally {
      shim.restore();
    }
  });
});

// ── CLI overrides env (general precedence sanity check) ─────────────

describe("parseCliArgs — CLI precedence over env", () => {
  it("CLI flag always wins when both env and CLI set the same option", () => {
    process.env.COPILOT_MODEL = "env-model";
    process.env.HYPERLIGHT_CPU_TIMEOUT_MS = "111";
    process.env.HYPERAGENT_VERBOSE = "1";
    const cli = parseCliArgs(["--model", "cli-model", "--cpu-timeout", "999"]);
    expect(cli.model).toBe("cli-model");
    expect(cli.cpuTimeout).toBe("999");
    // env-set verbose persists when no CLI override.
    expect(cli.verbose).toBe(true);
  });
});
