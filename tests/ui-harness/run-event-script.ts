// ── tests/ui-harness/run-event-script.ts ────────────────────────────
//
// Drive `registerEventHandler()` with a scripted sequence of session
// events and return the captured terminal output, normalised to
// semantic tags for stable golden comparison.
//
// What this gives us:
//   - A deterministic, side-effect-free way to assert "this stream
//     of events produces this terminal output".
//   - A safety net for the Phase 2 migration: when we move the
//     event handler from `console.log` → `ui.emit*`, the goldens
//     must keep matching. Any drift fails the test loudly.
//
// What this is NOT:
//   - A full agent integration test. We don't spawn the binary, we
//     don't talk to the SDK, and we don't run the sandbox. We poke
//     a single function under a controlled environment.
// ────────────────────────────────────────────────────────────────────

import { vi } from "vitest";
import type { SessionEvent } from "@github/copilot-sdk";

import { registerEventHandler } from "../../src/agent/event-handler.js";
import { Spinner } from "../../src/agent/spinner.js";
import { TerminalUI } from "../../src/agent/ui/index.js";
import type { AgentState } from "../../src/agent/state.js";

import { ansiToSemantic } from "./ansi-to-semantic.js";
import { captureStdio } from "./capture-stdio.js";
import { FakeSession } from "./fake-session.js";
import { makeTestState } from "./test-state.js";

// ── Constants ────────────────────────────────────────────────────────

/**
 * Inactivity timeout passed to the event handler.
 * Tests never let the timer fire (fake timers are in use), so the
 * exact value is cosmetic — picked to match the production default.
 */
const TEST_SEND_TIMEOUT_MS = 60_000;

/**
 * Max retries before the keep-alive gives up. Same rationale: only
 * matters if the timer fires, which it doesn't under fake timers.
 */
const TEST_MAX_INACTIVITY_RETRIES = 3;

// ── Options ──────────────────────────────────────────────────────────

/**
 * Optional knobs for `runEventScript`.
 */
export interface RunEventScriptOptions {
  /**
   * Override fields on the freshly-built `AgentState` before the
   * handler is registered. Use this to test toggles like
   * `verboseOutput: true` or `markdownEnabled: true`.
   */
  state?: Partial<AgentState>;
}

/**
 * Result of `runEventScript`.
 */
export interface EventScriptResult {
  /**
   * Captured stdout with ANSI escapes replaced by semantic tags.
   * This is the value to assert against goldens.
   */
  readonly stdout: string;
  /**
   * Captured stderr (semantic-normalised). Usually empty for the
   * event handler; surfaced for completeness.
   */
  readonly stderr: string;
  /**
   * Raw stdout bytes — for the rare test that needs to assert on
   * exact byte sequences (e.g. OSC title escapes).
   */
  readonly stdoutRaw: string;
}

// ── Runner ───────────────────────────────────────────────────────────

/**
 * Run a scripted sequence of `SessionEvent`s through
 * `registerEventHandler()` and return the captured output.
 *
 * Execution model:
 *   1. Vitest fake timers are installed for the duration of the call.
 *      This freezes `Date.now()` and silences `setInterval`/`setTimeout`,
 *      so the spinner never animates and the keep-alive never fires.
 *      Output stays deterministic.
 *   2. `process.stdout.write` and `process.stderr.write` are spied
 *      and buffered. The terminal never sees anything.
 *   3. A fresh `FakeSession` is created, the handler is registered
 *      on it, and the scripted events are dispatched in order.
 *   4. The spinner is explicitly stopped at the end (defensive — most
 *      event streams end with `session.idle` which stops it anyway).
 *   5. Spies are restored, fake timers are removed, the captured
 *      stdout/stderr is normalised and returned.
 *
 * Errors thrown by the handler propagate to the caller — the harness
 * still tears down spies and timers in a `finally` block first.
 */
export function runEventScript(
  events: SessionEvent[],
  options: RunEventScriptOptions = {},
): EventScriptResult {
  // Freeze time and silence timers BEFORE the spinner is constructed —
  // spinner.start() uses setInterval, which we want stubbed out.
  vi.useFakeTimers();

  const capture = captureStdio();
  try {
    const state = makeTestState(options.state);
    const spinner = new Spinner(state.verboseOutput);
    // TerminalUI receives a *live reference* to the state so the
    // `markdownEnabled` / `verboseOutput` toggles propagate without
    // re-construction. Tests can flip them in `options.state` and
    // see the matching display behaviour on the next event.
    const ui = new TerminalUI(spinner, state);
    const session = new FakeSession();

    registerEventHandler(session.asSession(), {
      state,
      ui,
      // `sandbox` is destructured but never used by registerEventHandler.
      // Cast through unknown to keep the structural contract loose.
      sandbox: {} as unknown as Parameters<
        typeof registerEventHandler
      >[1]["sandbox"],
      SEND_TIMEOUT_MS: TEST_SEND_TIMEOUT_MS,
      MAX_INACTIVITY_RETRIES: TEST_MAX_INACTIVITY_RETRIES,
      debugLog: () => {
        /* swallow debug logs in tests — they go to stderr in production */
      },
    });

    session.emitAll(events);

    // Defensive — most flows end with session.idle which stops the
    // spinner, but a partial event stream should still clean up.
    spinner.stop();

    const stdoutRaw = capture.stdout();
    return {
      stdoutRaw,
      stdout: ansiToSemantic(stdoutRaw),
      stderr: ansiToSemantic(capture.stderr()),
    };
  } finally {
    capture.restore();
    vi.useRealTimers();
  }
}
