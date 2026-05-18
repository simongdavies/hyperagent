// ── tests/ui-capture-harness.test.ts ─────────────────────────────────
//
// Golden tests for the agent's terminal output.
//
// What this guards against
// ─────────────────────────
// The Phase 2 refactor migrates ~40 direct `console.log` / `process.stdout.write`
// sites in `src/agent/event-handler.ts` to go through a new `AgentUI` port.
// Today there is **zero** automated coverage of "did the visible terminal
// output change?" — every change ships blind. These goldens close that gap.
//
// How it works
// ────────────
//   1. A scripted sequence of `SessionEvent`s is dispatched to
//      `registerEventHandler()` under fake timers and stdout capture.
//   2. The captured stdout is normalised: ANSI escapes → semantic tags
//      (`<green>`, `<bold>`, `<clear-line>`, …) so goldens are readable
//      and resilient to harmless byte-level churn.
//   3. The normalised string is compared against a checked-in golden
//      file under `tests/golden/ui/*.golden.txt`.
//
// Updating goldens
// ────────────────
// When you intentionally change output, run with `-u` (or `--update`):
//
//     npx vitest run tests/ui-capture-harness.test.ts -u
//
// Vitest will rewrite each golden file from the new actual output.
// **Review the diff carefully** — a runaway update will hide drift.
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { runEventScript, makeEventFactory } from "./ui-harness/index.js";

describe("event handler — golden flows", () => {
  it("streams plain text deltas in non-markdown mode", async () => {
    // The smallest possible "happy path" — one turn, two deltas, one
    // final message, idle. Locks down the streaming text path: deltas
    // must reach stdout verbatim (no buffering when markdown is off).
    const e = makeEventFactory();
    const events = [
      e.turnStart("turn-1"),
      e.messageDelta("Hello "),
      e.messageDelta("world!"),
      e.message("Hello world!"),
      e.idle(),
    ];

    const result = runEventScript(events);

    await expect(result.stdout).toMatchFileSnapshot(
      "./golden/ui/text-delta.golden.txt",
    );
    expect(result.stderr).toBe("");
  });

  it("buffers text silently in markdown mode (no stdout writes until render)", async () => {
    // Regression guard: with markdownEnabled = true, message_delta
    // must NOT write the streaming text to stdout — the full text is
    // rendered later by processMessage. We should only see the
    // spinner-clear from the first delta arriving.
    const e = makeEventFactory();
    const events = [
      e.turnStart("turn-1"),
      e.messageDelta("Hello "),
      e.messageDelta("world!"),
      e.message("Hello world!"),
      e.idle(),
    ];

    const result = runEventScript(events, { state: { markdownEnabled: true } });

    await expect(result.stdout).toMatchFileSnapshot(
      "./golden/ui/text-delta-markdown.golden.txt",
    );
  });

  it("renders a successful sandbox tool call with a result line", async () => {
    // `execute_javascript` / `execute_bash` are recognised as sandbox
    // tools and get their result re-displayed by the event handler
    // (non-sandbox tools are summarised by the LLM instead).
    const e = makeEventFactory();
    const events = [
      e.turnStart("turn-1"),
      e.toolStart("execute_javascript", "call-1"),
      e.toolCompleteOk("call-1", {
        content: JSON.stringify({ result: "42" }),
      }),
      e.idle(),
    ];

    const result = runEventScript(events);

    await expect(result.stdout).toMatchFileSnapshot(
      "./golden/ui/tool-success.golden.txt",
    );
  });

  it("renders a failing sandbox tool call with an error line", async () => {
    // The tool succeeded at running but the result payload carries
    // an `error` field — handler shows "❌ <message>".
    const e = makeEventFactory();
    const events = [
      e.turnStart("turn-1"),
      e.toolStart("execute_javascript", "call-1"),
      e.toolCompleteOk("call-1", {
        content: JSON.stringify({
          error: "ReferenceError: foo is not defined",
        }),
      }),
      e.idle(),
    ];

    const result = runEventScript(events);

    await expect(result.stdout).toMatchFileSnapshot(
      "./golden/ui/tool-error.golden.txt",
    );
  });

  it("renders a tool denied by policy", async () => {
    // SDK error code "denied" — shows the policy-denied warning line.
    const e = makeEventFactory();
    const events = [
      e.turnStart("turn-1"),
      e.toolStart("execute_javascript", "call-1"),
      e.toolCompleteErr("call-1", {
        message: "Sandbox refused",
        code: "denied",
      }),
      e.idle(),
    ];

    const result = runEventScript(events);

    await expect(result.stdout).toMatchFileSnapshot(
      "./golden/ui/tool-denied.golden.txt",
    );
  });

  it("renders an assistant.usage stats line after streamed content", async () => {
    // After streamed text the handler emits "\n" so stats land on a
    // fresh line, then prints "📊 ..." via TerminalUI.emitUsage.
    const e = makeEventFactory();
    const events = [
      e.turnStart("turn-1"),
      e.messageDelta("Done."),
      e.message("Done."),
      e.usage({
        model: "test-model",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 1,
        duration: 1234,
      }),
      e.idle(),
    ];

    const result = runEventScript(events);

    await expect(result.stdout).toMatchFileSnapshot(
      "./golden/ui/usage-stats.golden.txt",
    );
  });

  it("surfaces session.warning with a yellow ⚠️  line", async () => {
    const e = makeEventFactory();
    const events = [e.warning("Rate limit approaching"), e.idle()];

    const result = runEventScript(events);

    await expect(result.stdout).toMatchFileSnapshot(
      "./golden/ui/session-warning.golden.txt",
    );
  });

  it("surfaces session.error and stops the spinner", async () => {
    // session.error fires while a turn is in progress — spinner was
    // started by turn_start and must be cleared before the error
    // propagates back to the REPL.
    const e = makeEventFactory();
    const events = [e.turnStart("turn-1"), e.error("Model went sideways")];

    const result = runEventScript(events);

    await expect(result.stdout).toMatchFileSnapshot(
      "./golden/ui/session-error.golden.txt",
    );
  });

  it("emits the verbose-reasoning separator before the response text", async () => {
    // verboseOutput = true: reasoning deltas scroll inline as dim
    // italic text. When the first message_delta arrives, the handler
    // writes a "\x1b[0m\n\n" separator so the response text starts
    // cleanly on its own block.
    const e = makeEventFactory();
    const events = [
      e.turnStart("turn-1"),
      e.reasoningDelta("Let me think about this. "),
      e.reasoningDelta("OK got it."),
      e.messageDelta("Answer: 42."),
      e.message("Answer: 42."),
      e.idle(),
    ];

    const result = runEventScript(events, { state: { verboseOutput: true } });

    await expect(result.stdout).toMatchFileSnapshot(
      "./golden/ui/reasoning-verbose.golden.txt",
    );
  });
});
