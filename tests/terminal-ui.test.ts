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
//   1. Constructs `TerminalUI` (which owns its internal Spinner).
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
import { TerminalUI } from "../src/agent/ui/index.js";

/**
 * Construct a TerminalUI. The internal Spinner is now owned by
 * TerminalUI itself — callers drive its lifecycle through
 * `ui.setActivity(...)` / `ui.setActivity(null)`.
 */
function makeUI(
  opts: { markdownEnabled?: boolean; verboseOutput?: boolean } = {},
): { ui: TerminalUI } {
  const ui = new TerminalUI({
    markdownEnabled: opts.markdownEnabled ?? false,
    verboseOutput: opts.verboseOutput ?? false,
  });
  return { ui };
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
    const { ui } = makeUI();
    // Mimic turn.start — spinner running before the tool fires.
    ui.setActivity({ kind: "thinking", label: "Thinking..." });
    ui.emitToolStart({ name: "execute_javascript", callId: "call-1" });
    ui.emitToolResult({
      name: "execute_javascript",
      callId: "call-1",
      status: "success",
      message: "Done",
    });
    // Final stop mirrors the harness teardown so the trailing
    // `<cr><clear-line>` matches the existing golden.
    ui.setActivity(null);
    await expect(ansiToSemantic(cap.stdout())).toMatchFileSnapshot(
      "./golden/ui/tool-success.golden.txt",
    );
  });

  it("emitToolResult error: matches the event-handler golden", async () => {
    const { ui } = makeUI();
    ui.setActivity({ kind: "thinking", label: "Thinking..." });
    ui.emitToolStart({ name: "execute_javascript", callId: "call-1" });
    ui.emitToolResult({
      name: "execute_javascript",
      callId: "call-1",
      status: "error",
      message: "ReferenceError: foo is not defined",
    });
    ui.setActivity(null);
    await expect(ansiToSemantic(cap.stdout())).toMatchFileSnapshot(
      "./golden/ui/tool-error.golden.txt",
    );
  });

  it("emitToolResult denied: matches the event-handler golden", async () => {
    const { ui } = makeUI();
    ui.setActivity({ kind: "thinking", label: "Thinking..." });
    ui.emitToolStart({ name: "execute_javascript", callId: "call-1" });
    ui.emitToolResult({
      name: "execute_javascript",
      callId: "call-1",
      status: "denied",
      message: "Tool denied by policy",
    });
    ui.setActivity(null);
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
    const { ui } = makeUI();
    // Mimic turn.start — spinner running, then first text delta
    // clears it. This matches the script that produced the original
    // event-handler golden.
    ui.setActivity({ kind: "thinking", label: "Thinking..." });
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

// ── --no-color / --quiet flags (Phase 7) ─────────────────────────────
//
// Two TerminalUI options the CLI surfaces through `--no-color` and
// `--quiet`. The first strips SGR colour/attribute escapes from
// emitted bytes while leaving cursor-control codes intact; the
// second suppresses notifications at `level: "info"`.

describe("TerminalUI — --no-color flag", () => {
  let cap: StdioCapture;

  beforeEach(() => {
    vi.useFakeTimers();
    cap = captureStdio();
  });

  afterEach(() => {
    cap.restore();
    vi.useRealTimers();
  });

  it("strips SGR colour codes from emitted text", () => {
    const ui = new TerminalUI({
      markdownEnabled: false,
      verboseOutput: false,
      noColor: true,
    });
    // Manually inject an ANSI-coloured sequence to verify stripping.
    ui.emitText({ content: "\x1b[31mred\x1b[0m plain" });
    expect(cap.stdout()).toBe("red plain");
  });

  it("strips colours from emitNotification but preserves the message", () => {
    const ui = new TerminalUI({
      markdownEnabled: false,
      verboseOutput: false,
      noColor: true,
    });
    ui.emitNotification({
      level: "warning",
      kind: "sdk_warning",
      message: "watch out",
    });
    // The notification body must be present without any SGR escapes.
    const out = cap.stdout();
    expect(out).toContain("watch out");
    expect(out).not.toMatch(/\x1b\[[0-9;]*m/);
  });

  it("preserves cursor-control sequences (line clears, cursor moves)", () => {
    const ui = new TerminalUI({
      markdownEnabled: false,
      verboseOutput: false,
      noColor: true,
    });
    // Drive the internal spinner so it emits a clear-line sequence.
    ui.setActivity({ kind: "thinking", label: "Thinking..." });
    ui.setActivity(null);
    // Cursor-control survives even with noColor.
    expect(cap.stdout()).toMatch(/\x1b\[2K/);
    // But no SGR (colour / attribute) codes leak through.
    expect(cap.stdout()).not.toMatch(/\x1b\[[0-9;]*m/);
  });

  it("emits colour codes when noColor is false (regression guard)", () => {
    const ui = new TerminalUI({
      markdownEnabled: false,
      verboseOutput: false,
      noColor: false,
    });
    ui.emitNotification({
      level: "warning",
      kind: "sdk_warning",
      message: "watch out",
    });
    // The warning notification must include at least one SGR escape.
    expect(cap.stdout()).toMatch(/\x1b\[[0-9;]*m/);
  });
});

describe("TerminalUI — --quiet flag", () => {
  let cap: StdioCapture;

  beforeEach(() => {
    vi.useFakeTimers();
    cap = captureStdio();
  });

  afterEach(() => {
    cap.restore();
    vi.useRealTimers();
  });

  it("suppresses info-level notifications", () => {
    const ui = new TerminalUI({
      markdownEnabled: false,
      verboseOutput: false,
      quiet: true,
    });
    ui.emitNotification({
      level: "info",
      kind: "generic",
      message: "hush",
    });
    expect(cap.stdout()).toBe("");
  });

  it("still emits warning / error / success / plain notifications", () => {
    const ui = new TerminalUI({
      markdownEnabled: false,
      verboseOutput: false,
      quiet: true,
    });
    ui.emitNotification({
      level: "warning",
      kind: "sdk_warning",
      message: "warn",
    });
    ui.emitNotification({
      level: "error",
      kind: "sdk_error",
      message: "err",
    });
    ui.emitNotification({
      level: "success",
      kind: "task_complete",
      message: "ok",
    });
    ui.emitNotification({
      level: "plain",
      kind: "audit_phase",
      message: "phase",
    });
    const out = cap.stdout();
    expect(out).toContain("warn");
    expect(out).toContain("err");
    expect(out).toContain("ok");
    expect(out).toContain("phase");
  });

  it("emits info-level when quiet is false (regression guard)", () => {
    const ui = new TerminalUI({
      markdownEnabled: false,
      verboseOutput: false,
      quiet: false,
    });
    ui.emitNotification({
      level: "info",
      kind: "generic",
      message: "hello",
    });
    expect(cap.stdout()).toContain("hello");
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
