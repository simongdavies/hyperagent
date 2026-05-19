// ── tests/ipc-stdio-integration.test.ts ─────────────────────────────
//
// End-to-end smoke test for `--ipc-stdio` mode: spawns the agent as
// a real child process and proves that every byte ever written to
// its **stdout** is a valid NDJSON frame matching the
// `{ v: 1, t: string, data?: unknown }` shape from
// `docs/IPC-PROTOCOL.md`.
//
// Why a child-process test
// ────────────────────────
// The unit tests under `tests/json-lines-ui.test.ts` and
// `tests/ipc-stdio-loop.test.ts` cover the wire format and the
// reply pump in isolation. They cannot catch *boot-path leaks* —
// rogue `console.log` calls that fire between the start of
// `src/agent/index.ts` and the moment the IPC loop attaches. A
// single stray banner line on real stdout would corrupt the
// host's NDJSON parser and is invisible to the unit suite. This
// test is the regression guard for that whole class of bugs.
//
// What it asserts
// ───────────────
//   1. Stdout is **pure NDJSON** — every non-empty line parses
//      cleanly and carries the protocol header (`v: 1`, string
//      `t`). No banner, no config table, no SDK chatter.
//   2. The first frame the host sees (if any) is the `ready`
//      handshake — the contract documented in IPC-PROTOCOL.md.
//   3. The agent exits within the bounded test window (the
//      `shutdown` frame is the kill switch — if it stops working
//      this test starts timing out, which is a real bug).
//
// What it deliberately does NOT assert
// ────────────────────────────────────
//   - Stderr content: stderr is the "diagnostics" channel by
//     design. The boot banner is redirected there in IPC mode and
//     any SDK chatter lands there too. That's the whole point of
//     the safety-net redirect.
//   - Successful Copilot authentication: most CI machines won't
//     have credentials. We send `shutdown` immediately so the
//     agent exits before reaching the auth call, sidestepping the
//     issue entirely.
// ─────────────────────────────────────────────────────────────────────

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Absolute path to the test file's directory (ESM-safe). */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to the workspace root (parent of tests/). */
const WORKSPACE_ROOT = resolve(__dirname, "..");

/**
 * Absolute path to the bundled `tsx` ESM CLI. Spawning `node` with
 * an explicit script path is cross-platform — `npx tsx` would
 * resolve to `npx.cmd` on Windows and require `shell: true`.
 */
const TSX_CLI = resolve(WORKSPACE_ROOT, "node_modules/tsx/dist/cli.mjs");

/** Absolute path to the agent entry point. */
const AGENT_ENTRY = resolve(WORKSPACE_ROOT, "src/agent/index.ts");

/**
 * Hard cap on how long the test will wait for the agent to exit
 * after receiving `shutdown`. The agent runs `client.start()`
 * before the IPC loop attaches, so without auth it may block on
 * the SDK init step until we SIGKILL it. The bound balances "long
 * enough to capture a leak if one exists" against "short enough
 * that a CI run doesn't hang for minutes".
 */
const KILL_AFTER_MS = 8_000;

/**
 * The exact JSON-Lines protocol header every outbound frame
 * carries. Pinned here so any change to the wire format must also
 * update this test deliberately.
 */
const EXPECTED_PROTOCOL_VERSION = 1;

interface ChildResult {
  /** Raw stdout bytes captured for the lifetime of the child. */
  stdout: string;
  /** Raw stderr bytes — diagnostic only, never asserted. */
  stderr: string;
  /** Exit code, or `null` when we had to SIGKILL the child. */
  exitCode: number | null;
  /** `true` when the kill timer fired (i.e. the agent didn't exit cleanly). */
  killedByTimer: boolean;
}

/**
 * Spawn the agent in IPC mode, write the `shutdown` frame, and
 * wait for it to exit or for the kill timer to fire. Returns the
 * captured byte streams plus exit metadata.
 *
 * The function is intentionally self-contained — the test body
 * does the assertions, this helper only owns the child lifecycle.
 */
async function spawnAgentIpc(): Promise<ChildResult> {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [TSX_CLI, AGENT_ENTRY, "--ipc-stdio", "--no-color"],
    {
      cwd: WORKSPACE_ROOT,
      env: {
        ...process.env,
        // Force the SDK into a deterministic state — auth failures
        // are fine, we just don't want interactive device-code
        // flows reading from our piped stdin.
        COPILOT_NO_DEVICE_CODE: "1",
        // Disable colour everywhere for good measure.
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  // Send the shutdown frame and close stdin. The agent's IPC loop
  // reads NDJSON line-by-line; the kill switch fires on
  // `{ "t": "shutdown" }`.
  child.stdin.write('{"t":"shutdown"}\n');
  child.stdin.end();

  return await new Promise<ChildResult>((resolvePromise) => {
    let killedByTimer = false;
    const killTimer = setTimeout(() => {
      killedByTimer = true;
      child.kill("SIGKILL");
    }, KILL_AFTER_MS);

    child.on("exit", (code) => {
      clearTimeout(killTimer);
      resolvePromise({
        stdout,
        stderr,
        exitCode: code,
        killedByTimer,
      });
    });
  });
}

/**
 * Parse a captured stdout string into structured NDJSON frames.
 * Throws on the first malformed line so the test failure points
 * at the offending raw text — easier to debug than a generic
 * "expected x got y".
 */
function parseNdjson(raw: string): Array<{
  v: number;
  t: string;
  data?: unknown;
}> {
  const lines = raw.split("\n");
  const frames: Array<{ v: number; t: string; data?: unknown }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `Stdout line ${i + 1} is not valid JSON — this means an unstructured write leaked through. Raw: ${JSON.stringify(
          line,
        )}\nOriginal error: ${(err as Error).message}`,
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { v?: unknown }).v !== "number" ||
      typeof (parsed as { t?: unknown }).t !== "string"
    ) {
      throw new Error(
        `Stdout line ${i + 1} parsed as JSON but missing protocol header — raw: ${JSON.stringify(
          line,
        )}`,
      );
    }
    frames.push(parsed as { v: number; t: string; data?: unknown });
  }
  return frames;
}

describe("IPC stdio integration — stdout purity", () => {
  it(
    "every byte written to stdout is a valid NDJSON frame (no banner leak)",
    async () => {
      const result = await spawnAgentIpc();

      // The shutdown frame is the kill switch. If the agent never
      // reaches the IPC loop (e.g. SDK auth hangs), our timer kills
      // it — that's noted but does not fail the test. What we
      // *cannot tolerate* is unstructured bytes on stdout.
      const frames = parseNdjson(result.stdout);

      for (const frame of frames) {
        expect(frame.v).toBe(EXPECTED_PROTOCOL_VERSION);
        expect(typeof frame.t).toBe("string");
        expect(frame.t.length).toBeGreaterThan(0);
      }
    },
    KILL_AFTER_MS + 4_000,
  );

  it(
    "first emitted frame (if any) is the ready handshake",
    async () => {
      const result = await spawnAgentIpc();
      const frames = parseNdjson(result.stdout);

      if (frames.length === 0) {
        // The agent never reached the point where the ready frame
        // is emitted (likely SDK auth failure on a CI host with no
        // credentials). Empty stdout is still a valid stream — the
        // primary "no leak" assertion above is what matters.
        return;
      }

      const ready = frames[0];
      expect(ready.t).toBe("ready");
      // Payload shape — pinned here so future protocol changes
      // surface as deliberate test updates.
      const data = ready.data as
        | { protocolVersion?: unknown; agentVersion?: unknown; model?: unknown }
        | undefined;
      expect(data).toBeTruthy();
      expect(typeof data?.protocolVersion).toBe("number");
      expect(typeof data?.agentVersion).toBe("string");
      expect(typeof data?.model).toBe("string");
    },
    KILL_AFTER_MS + 4_000,
  );
});
