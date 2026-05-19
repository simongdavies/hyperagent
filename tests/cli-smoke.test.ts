// ── tests/cli-smoke.test.ts ──────────────────────────────────────────
//
// Subprocess smoke tests for CLI flags that drive a terminator
// path — i.e. flags that print something and exit cleanly without
// needing Copilot auth, plugins, or the sandbox to boot.
//
// What this covers
// ────────────────
//   * `--version` / `-v`  → prints `v<semver>` on stdout, exits 0
//   * `--help`    / `-h`  → prints the usage banner on stdout,
//                           exits 0, lists every advertised flag
//
// Why a subprocess
// ────────────────
//   The exit/print paths execute at the top of `src/agent/index.ts`,
//   AFTER the env-var propagation runs. A unit test on
//   `parseCliArgs` proves the flag is parsed, but it cannot prove
//   that the very next thing `index.ts` does is print and exit.
//   Spawning the real binary closes that gap with a single
//   end-to-end assertion.
//
// What this DOES NOT cover
// ────────────────────────
//   * `--list-models`  — hits Copilot's REST API for the live
//     model catalogue. Auth-dependent → not suitable for CI.
//   * `--ipc-stdio`    — covered separately by
//     `tests/ipc-stdio-integration.test.ts`.
//   * `--mcp-*`        — covered by the standalone MCP setup
//     command tests in `tests/tune.test.ts` (parser) and the MCP
//     test suites for the runtime side-effects.
//
// ─────────────────────────────────────────────────────────────────────

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Absolute path to the test file's directory (ESM-safe). */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Workspace root — parent of `tests/`. */
const WORKSPACE_ROOT = resolve(__dirname, "..");

/**
 * The bundled `tsx` ESM CLI we use to spawn the agent. Going via
 * the explicit script path (rather than `npx tsx`) means the test
 * works the same on every platform — `npx` is `npx.cmd` on
 * Windows and would need `shell: true`.
 */
const TSX_CLI = resolve(WORKSPACE_ROOT, "node_modules/tsx/dist/cli.mjs");

/** The agent entry point. */
const AGENT_ENTRY = resolve(WORKSPACE_ROOT, "src/agent/index.ts");

/**
 * Hard wall-clock cap for the entire subprocess invocation. These
 * are terminator-path tests — they should exit in well under a
 * second on any sane machine. 30s is generous enough that a cold
 * Node start on a loaded CI runner still fits.
 */
const TIMEOUT_MS = 30_000;

/**
 * Run the agent with the given argv and return the captured stdio.
 * The child inherits a clean-enough env (NO_COLOR=1 so banners
 * don't carry ANSI escapes the assertions would have to strip).
 */
function runAgent(args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [TSX_CLI, AGENT_ENTRY, ...args], {
    cwd: WORKSPACE_ROOT,
    env: {
      ...process.env,
      // Make output deterministic across local runs / CI / TTY-less
      // pipes. The version/help paths never use colour anyway, but
      // pinning it removes one source of flakes.
      NO_COLOR: "1",
      // Suppress any device-code prompts on the off chance some
      // import-time module decides to phone home.
      COPILOT_NO_DEVICE_CODE: "1",
    },
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    // tsx writes its own stderr banner ("✔ ts-node" etc.) — keep
    // it out of our captures so error messages stay clean if a
    // test fails.
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("--version / -v subprocess smoke", () => {
  it(
    "--version prints `v<semver>` on stdout and exits 0",
    () => {
      const result = runAgent(["--version"]);
      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
      // Format: `v` followed by a semver-ish string. Build metadata
      // (+sha.dirty etc.) is allowed by the version generator.
      expect(result.stdout.trim()).toMatch(/^v\d+\.\d+\.\d+/);
    },
    TIMEOUT_MS,
  );

  it(
    "-v alias prints the same as --version",
    () => {
      const long = runAgent(["--version"]);
      const short = runAgent(["-v"]);
      expect(short.status).toBe(0);
      expect(short.stdout.trim()).toBe(long.stdout.trim());
    },
    TIMEOUT_MS,
  );
});

describe("--help / -h subprocess smoke", () => {
  it(
    "--help prints the usage banner, exits 0, lists every documented flag",
    () => {
      const result = runAgent(["--help"]);
      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
      const out = result.stdout;
      // Sanity: it's the usage text, not some random log.
      expect(out).toMatch(/^\s*\n?Usage:/);
      // Spot-check every flag the parser actually handles. This is
      // the test that fails loudly if someone adds a flag to the
      // parser switch but forgets to document it in printUsage().
      const ADVERTISED = [
        "--model",
        "--cpu-timeout",
        "--wall-timeout",
        "--send-timeout",
        "--heap-size",
        "--scratch-size",
        "--show-code",
        "--show-timing",
        "--reasoning-effort",
        "--verbose",
        "--very-verbose",
        "--[no-]markdown",
        "--transcript",
        "--list-models",
        "--resume",
        "--plugins-dir",
        "--debug",
        "--tune",
        "--profile",
        "--auto-approve",
        "--base-dir",
        "--prompt",
        "--prompt-file",
        "--skill",
        "--output-threshold",
        "--no-color",
        "--quiet",
        "--attach",
        "--ipc-stdio",
        "--version",
        "--help",
      ];
      for (const flag of ADVERTISED) {
        expect(out, `--help is missing ${flag}`).toContain(flag);
      }
    },
    TIMEOUT_MS,
  );

  it(
    "-h alias prints the same usage banner",
    () => {
      const long = runAgent(["--help"]);
      const short = runAgent(["-h"]);
      expect(short.status).toBe(0);
      expect(short.stdout).toBe(long.stdout);
    },
    TIMEOUT_MS,
  );
});

describe("unknown option", () => {
  it(
    "exits with status 1 and emits a helpful error to stderr",
    () => {
      const result = runAgent(["--definitely-not-a-flag"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/Unknown option: --definitely-not-a-flag/);
    },
    TIMEOUT_MS,
  );
});
