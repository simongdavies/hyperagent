// ── tests/terminal-ui.test.ts ────────────────────────────────────────
//
// Parallel goldens for `TerminalUI`.
//
// What this proves
// ────────────────
// Phase 2 of the AgentUI refactor will rewrite `event-handler.ts` to
// call `ui.emit*` instead of writing directly to stdout. For the
// Phase 0 goldens to keep passing through that migration, `TerminalUI`
// must reproduce the same bytes the handler currently emits.
//
// We assert that here, *before* any call site changes. Each test:
//   1. Constructs `TerminalUI` with a fake spinner.
//   2. Drives the same logical flow that the Phase 0 goldens
//      exercise (text streaming, tool start/result, notifications…).
//   3. Compares the captured stdout against the same golden files
//      the event-handler tests already wrote.
//
// When this test agrees with the existing goldens, Phase 2 is safe.
// ─────────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ansiToSemantic,
  captureStdio,
  type StdioCapture,
} from "./ui-harness/index.js";
import { Spinner } from "../src/agent/spinner.js";
import { TerminalUI } from "../src/agent/ui/index.js";

/**
 * Construct a TerminalUI plus the spinner it drives. We hand the
 * spinner back so individual tests can `spinner.stop()` at the end
 * to flush any pending clear sequences — mirrors the harness's
 * own teardown step.
 */
function makeUI(
  opts: { markdownEnabled?: boolean; verboseOutput?: boolean } = {},
): { ui: TerminalUI; spinner: Spinner } {
  const spinner = new Spinner(false);
  const ui = new TerminalUI(spinner, {
    markdownEnabled: opts.markdownEnabled ?? false,
    verboseOutput: opts.verboseOutput ?? false,
  });
  return { ui, spinner };
}

describe("TerminalUI — byte-for-byte parity with event-handler", () => {
  let cap: StdioCapture;

  beforeEach(() => {
    // Stub timers via the same pattern as the event-handler tests —
    // the spinner's setInterval should never tick mid-test.
    vi.useFakeTimers();
    cap = captureStdio();
  });

  afterEach(() => {
    cap.restore();
    vi.useRealTimers();
  });

  it("emitText: streams content verbatim in non-markdown mode", () => {
    const { ui } = makeUI();
    ui.emitText({ content: "Hello " });
    ui.emitText({ content: "world!" });
    expect(cap.stdout()).toBe("Hello world!");
  });

  it("emitText: suppressed in markdown mode (regression guard)", () => {
    const { ui } = makeUI({ markdownEnabled: true });
    ui.emitText({ content: "Hello " });
    ui.emitText({ content: "world!" });
    expect(cap.stdout()).toBe("");
  });

  it("renderMarkdown: prints the rendered output as a console line", () => {
    const { ui } = makeUI({ markdownEnabled: true });
    ui.renderMarkdown({ source: "**bold**" });
    // The renderer adds ANSI bold + reset; we don't pin the exact
    // bytes (markdown renderer changes shouldn't break this test),
    // we only check that something landed containing the word and
    // that it ended with a newline (console.log).
    expect(cap.stdout()).toContain("bold");
    expect(cap.stdout().endsWith("\n")).toBe(true);
  });

  it("emitToolStart + emitToolResult success: matches the event-handler golden", async () => {
    const { ui, spinner } = makeUI();
    // Mimic turn.start — spinner running before the tool fires.
    spinner.start("Thinking...");
    ui.emitToolStart({ name: "execute_javascript", callId: "call-1" });
    ui.emitToolResult({
      name: "execute_javascript",
      callId: "call-1",
      status: "success",
      message: "Done",
    });
    // Final spinner.stop mirrors the harness teardown so the
    // trailing `<cr><clear-line>` matches the existing golden.
    spinner.stop();
    await expect(ansiToSemantic(cap.stdout())).toMatchFileSnapshot(
      "./golden/ui/tool-success.golden.txt",
    );
  });

  it("emitToolResult error: matches the event-handler golden", async () => {
    const { ui, spinner } = makeUI();
    spinner.start("Thinking...");
    ui.emitToolStart({ name: "execute_javascript", callId: "call-1" });
    ui.emitToolResult({
      name: "execute_javascript",
      callId: "call-1",
      status: "error",
      message: "ReferenceError: foo is not defined",
    });
    spinner.stop();
    await expect(ansiToSemantic(cap.stdout())).toMatchFileSnapshot(
      "./golden/ui/tool-error.golden.txt",
    );
  });

  it("emitToolResult denied: matches the event-handler golden", async () => {
    const { ui, spinner } = makeUI();
    spinner.start("Thinking...");
    ui.emitToolStart({ name: "execute_javascript", callId: "call-1" });
    ui.emitToolResult({
      name: "execute_javascript",
      callId: "call-1",
      status: "denied",
      message: "Tool denied by policy",
    });
    spinner.stop();
    await expect(ansiToSemantic(cap.stdout())).toMatchFileSnapshot(
      "./golden/ui/tool-denied.golden.txt",
    );
  });

  it("emitNotification warning: matches the session-warning golden", async () => {
    const { ui } = makeUI();
    ui.emitNotification({
      level: "warning",
      kind: "sdk_warning",
      icon: "⚠️ ",
      message: "Rate limit approaching",
    });
    await expect(ansiToSemantic(cap.stdout())).toMatchFileSnapshot(
      "./golden/ui/session-warning.golden.txt",
    );
  });

  it("emitUsage after streamed text: prepends a newline and prints stats", async () => {
    const { ui, spinner } = makeUI();
    // Mimic turn.start — spinner running, then first text delta
    // clears it. This matches the script that produced the original
    // event-handler golden.
    spinner.start("Thinking...");
    ui.emitText({ content: "Done." });
    // The caller is currently responsible for prepending the \n —
    // matches event-handler.ts:484. Phase 2 will preserve this
    // behaviour; we emit it manually here to match the golden.
    process.stdout.write("\n");
    ui.emitUsage({
      model: "test-model",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 1,
      durationMs: 1234,
    });
    await expect(ansiToSemantic(cap.stdout())).toMatchFileSnapshot(
      "./golden/ui/usage-stats.golden.txt",
    );
  });

  it("setWindowTitle: emits the OSC escape with the HyperAgent prefix", () => {
    const { ui } = makeUI();
    ui.setWindowTitle({ title: "My Session" });
    expect(cap.stdout()).toBe("\x1b]2;HyperAgent: My Session\x07");
  });
});

// ── NullUI ───────────────────────────────────────────────────────────
//
// The null implementation must satisfy the `AgentUI` interface at
// compile time (caught by `tsc`) and produce zero bytes at runtime.
// We assert both here so future port additions can't silently
// regress the null adapter.

import { NullUI, type AgentUI } from "../src/agent/ui/index.js";

describe("NullUI — silent AgentUI implementation", () => {
  let cap: StdioCapture;

  beforeEach(() => {
    cap = captureStdio();
  });

  afterEach(() => {
    cap.restore();
  });

  it("structurally satisfies AgentUI and emits no bytes", () => {
    // Compile-time check: assigning a NullUI to an AgentUI-typed
    // variable would fail typecheck if the interface drifted.
    const ui: AgentUI = new NullUI();
    ui.emitText({ content: "swallowed" });
    ui.emitReasoning({ content: "swallowed" });
    ui.emitReasoningTransition({});
    ui.renderMarkdown({ source: "**bold**" });
    ui.emitToolStart({ name: "tool", callId: "1" });
    ui.emitToolResult({
      name: "tool",
      callId: "1",
      status: "success",
      message: "Done",
    });
    ui.setActivity({ kind: "thinking", label: "Thinking..." });
    ui.setActivity(null);
    ui.setWindowTitle({ title: "ignored" });
    ui.emitNotification({
      level: "info",
      kind: "generic",
      message: "ignored",
    });
    ui.emitUsage({ inputTokens: 1, outputTokens: 1 });
    expect(cap.stdout()).toBe("");
    expect(cap.stderr()).toBe("");
  });
});
