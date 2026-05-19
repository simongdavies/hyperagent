// ── tests/json-lines-ui.test.ts ─────────────────────────────────────
//
// Unit tests for `JsonLinesUI` — the headless `AgentUI` that emits
// every agent side-effect as one newline-delimited JSON object per
// stdout write.
//
// What this proves
// ────────────────
//   1. Every emit method writes exactly one frame to the configured
//      sink, terminated by `\n`, with `v: 1` and the expected `t`
//      tag and `data` payload.
//   2. Empty-content guards in `emitText` / `emitReasoning` /
//      `renderMarkdown` suppress the write entirely (matching the
//      legacy `TerminalUI` behaviour — empty deltas were always
//      a no-op).
//   3. Sink exceptions are swallowed silently — the port contract
//      requires emit methods to be non-throwing.
//   4. Modal `ask*` methods write a request frame carrying a
//      correlation id and return a promise that resolves only when
//      `resolve*(id, …)` is called with the matching id.
//   5. `cancelAllPending` resolves every outstanding prompt with
//      its safe default so the shutdown path can never deadlock.
//   6. Mismatched / unknown id values are silently dropped on the
//      `resolve*` path — the host pipe is best-effort.
//
// Wire-format details that this test pins are part of the agent's
// external contract (consumed by the future Electron renderer);
// changes here are intentional protocol changes.
// ─────────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JSON_LINES_PROTOCOL_VERSION,
  JsonLinesUI,
} from "../src/agent/ui/json-lines-ui.js";

/**
 * Build a UI that captures every emitted frame into an array for
 * test inspection. Returns the UI plus the buffer so tests can
 * assert on the writes in order.
 */
function makeUI(opts: { generateId?: () => string } = {}): {
  ui: JsonLinesUI;
  frames: string[];
} {
  const frames: string[] = [];
  const ui = new JsonLinesUI({
    write: (chunk) => frames.push(chunk),
    generateId: opts.generateId,
  });
  return { ui, frames };
}

/**
 * Parse the captured frames into the structured event shape that
 * consumers will see. Verifies the trailing `\n` and the `v: 1`
 * header on every frame as a side-effect — keep this central so
 * the wire-format invariants are enforced from one place.
 */
function parseFrames(frames: string[]): Array<{
  v: number;
  t: string;
  data?: unknown;
}> {
  return frames.map((line) => {
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed.v).toBe(JSON_LINES_PROTOCOL_VERSION);
    expect(typeof parsed.t).toBe("string");
    return parsed;
  });
}

describe("JsonLinesUI — streaming output", () => {
  it("emitText: writes one text-delta frame with the chunk content", () => {
    const { ui, frames } = makeUI();
    ui.emitText({ content: "Hello " });
    ui.emitText({ content: "world!" });
    const parsed = parseFrames(frames);
    expect(parsed).toEqual([
      { v: 1, t: "text-delta", data: { content: "Hello " } },
      { v: 1, t: "text-delta", data: { content: "world!" } },
    ]);
  });

  it("emitText: empty content is suppressed (matches TerminalUI)", () => {
    const { ui, frames } = makeUI();
    ui.emitText({ content: "" });
    expect(frames).toEqual([]);
  });

  it("emitReasoning: writes one reasoning-delta frame", () => {
    const { ui, frames } = makeUI();
    ui.emitReasoning({ content: "thinking..." });
    expect(parseFrames(frames)).toEqual([
      { v: 1, t: "reasoning-delta", data: { content: "thinking..." } },
    ]);
  });

  it("emitReasoning: empty content is suppressed", () => {
    const { ui, frames } = makeUI();
    ui.emitReasoning({ content: "" });
    expect(frames).toEqual([]);
  });

  it("emitReasoningTransition: forwards the payload (including optional fields)", () => {
    const { ui, frames } = makeUI();
    ui.emitReasoningTransition({});
    ui.emitReasoningTransition({
      showBanner: true,
      indent: "    ",
      nextActivity: "Generating...",
    });
    expect(parseFrames(frames)).toEqual([
      { v: 1, t: "reasoning-transition", data: {} },
      {
        v: 1,
        t: "reasoning-transition",
        data: {
          showBanner: true,
          indent: "    ",
          nextActivity: "Generating...",
        },
      },
    ]);
  });

  it("clearReasoningBuffer: emits a payload-less marker frame", () => {
    const { ui, frames } = makeUI();
    ui.clearReasoningBuffer();
    const parsed = parseFrames(frames);
    expect(parsed.length).toBe(1);
    expect(parsed[0]).toEqual({ v: 1, t: "clear-reasoning-buffer" });
    // Payload-less frames must NOT carry a `data` field at all —
    // wire-format consumers expect `data` to be present iff there
    // is a payload to ship.
    expect("data" in (parsed[0] ?? {})).toBe(false);
  });

  it("hasBufferedReasoning: always false (host owns rendering policy)", () => {
    const { ui } = makeUI();
    expect(ui.hasBufferedReasoning()).toBe(false);
  });

  it("setVerboseReasoning: emits a verbose-reasoning frame with the new value", () => {
    const { ui, frames } = makeUI();
    ui.setVerboseReasoning(true);
    ui.setVerboseReasoning(false);
    expect(parseFrames(frames)).toEqual([
      { v: 1, t: "verbose-reasoning", data: { value: true } },
      { v: 1, t: "verbose-reasoning", data: { value: false } },
    ]);
  });

  it("renderMarkdown: writes one markdown frame with raw source", () => {
    const { ui, frames } = makeUI();
    ui.renderMarkdown({ source: "**bold**" });
    expect(parseFrames(frames)).toEqual([
      { v: 1, t: "markdown", data: { source: "**bold**" } },
    ]);
  });

  it("renderMarkdown: empty source is suppressed", () => {
    const { ui, frames } = makeUI();
    ui.renderMarkdown({ source: "" });
    expect(frames).toEqual([]);
  });
});

describe("JsonLinesUI — tool calls", () => {
  it("emitToolStart: writes one tool-start frame", () => {
    const { ui, frames } = makeUI();
    ui.emitToolStart({ name: "execute_javascript", callId: "c1" });
    expect(parseFrames(frames)).toEqual([
      {
        v: 1,
        t: "tool-start",
        data: { name: "execute_javascript", callId: "c1" },
      },
    ]);
  });

  it("emitToolResult: forwards every payload field, including optional body/hint/silent", () => {
    const { ui, frames } = makeUI();
    ui.emitToolResult({
      name: "execute_javascript",
      callId: "c1",
      status: "success",
      message: "Done",
      body: { kind: "json", content: '{"foo":1}' },
      hint: "trailing hint",
      silent: false,
    });
    expect(parseFrames(frames)).toEqual([
      {
        v: 1,
        t: "tool-result",
        data: {
          name: "execute_javascript",
          callId: "c1",
          status: "success",
          message: "Done",
          body: { kind: "json", content: '{"foo":1}' },
          hint: "trailing hint",
          silent: false,
        },
      },
    ]);
  });
});

describe("JsonLinesUI — status / activity", () => {
  it("beginTurn: emits a payload-less marker", () => {
    const { ui, frames } = makeUI();
    ui.beginTurn();
    const parsed = parseFrames(frames);
    expect(parsed).toEqual([{ v: 1, t: "begin-turn" }]);
    expect("data" in (parsed[0] ?? {})).toBe(false);
  });

  it("setActivity: writes the payload object", () => {
    const { ui, frames } = makeUI();
    ui.setActivity({ kind: "thinking", label: "Thinking..." });
    expect(parseFrames(frames)).toEqual([
      {
        v: 1,
        t: "activity",
        data: { kind: "thinking", label: "Thinking..." },
      },
    ]);
  });

  it("setActivity(null): emits data: null so consumers can distinguish 'clear' from 'no payload'", () => {
    const { ui, frames } = makeUI();
    ui.setActivity(null);
    const parsed = parseFrames(frames);
    expect(parsed).toEqual([{ v: 1, t: "activity", data: null }]);
  });

  it("setWindowTitle: forwards the title verbatim (UI host owns branding)", () => {
    const { ui, frames } = makeUI();
    ui.setWindowTitle({ title: "claude-opus-4.6" });
    expect(parseFrames(frames)).toEqual([
      { v: 1, t: "window-title", data: { title: "claude-opus-4.6" } },
    ]);
  });
});

describe("JsonLinesUI — notifications & usage", () => {
  it("emitNotification: forwards every notification field", () => {
    const { ui, frames } = makeUI();
    ui.emitNotification({
      level: "warning",
      kind: "context_truncated",
      icon: "⚠️",
      message: "Context truncated",
      indent: "    ",
    });
    expect(parseFrames(frames)).toEqual([
      {
        v: 1,
        t: "notification",
        data: {
          level: "warning",
          kind: "context_truncated",
          icon: "⚠️",
          message: "Context truncated",
          indent: "    ",
        },
      },
    ]);
  });

  it("emitUsage: forwards every usage field, omitting undefineds (JSON.stringify behaviour)", () => {
    const { ui, frames } = makeUI();
    ui.emitUsage({
      model: "claude-opus-4.6",
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 1234,
    });
    const parsed = parseFrames(frames);
    expect(parsed).toEqual([
      {
        v: 1,
        t: "usage",
        data: {
          model: "claude-opus-4.6",
          inputTokens: 100,
          outputTokens: 50,
          durationMs: 1234,
        },
      },
    ]);
  });
});

describe("JsonLinesUI — bootstrap handshake", () => {
  it("emitReady: writes one ready frame echoing every payload field verbatim", () => {
    const { ui, frames } = makeUI();
    ui.emitReady({
      protocolVersion: JSON_LINES_PROTOCOL_VERSION,
      agentVersion: "0.6.2-alpha.27+abc1234",
      model: "claude-opus-4.6",
    });
    expect(parseFrames(frames)).toEqual([
      {
        v: 1,
        t: "ready",
        data: {
          protocolVersion: JSON_LINES_PROTOCOL_VERSION,
          agentVersion: "0.6.2-alpha.27+abc1234",
          model: "claude-opus-4.6",
        },
      },
    ]);
  });
});

describe("JsonLinesUI.redirectConsoleLogToStderr", () => {
  // The helper mutates global `console` state. We snapshot the
  // original references in `beforeEach` and restore them in
  // `afterEach` so test ordering can't bleed state.
  const REDIRECT_FLAG = "__hyperagent_jsonLinesUI_logRedirected__";
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  beforeEach(() => {
    originalLog = console.log;
    originalError = console.error;
    delete (console as unknown as Record<string, unknown>)[REDIRECT_FLAG];
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    delete (console as unknown as Record<string, unknown>)[REDIRECT_FLAG];
  });

  it("rewires console.log to console.error so stray writes hit stderr", () => {
    const errorSpy = vi.fn();
    console.error = errorSpy;

    JsonLinesUI.redirectConsoleLogToStderr();
    console.log("hello", 42);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("hello", 42);
  });

  it("does not write to stdout after redirect", () => {
    // The real stdout sink would corrupt the NDJSON wire stream, so
    // we spy on it to prove no byte ever reaches it once the helper
    // has run. `process.stdout.write` is the byte sink that
    // `console.log` eventually invokes pre-redirect.
    const stdoutSpy = vi.spyOn(process.stdout, "write");
    // Replace console.error with a no-op so any redirected output
    // does not actually print during the test run.
    console.error = vi.fn();

    JsonLinesUI.redirectConsoleLogToStderr();
    console.log("must not reach stdout");

    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });

  it("is idempotent — calling twice leaves console.log pointing at the same target", () => {
    console.error = vi.fn();

    JsonLinesUI.redirectConsoleLogToStderr();
    const afterFirst = console.log;
    JsonLinesUI.redirectConsoleLogToStderr();
    const afterSecond = console.log;

    expect(afterFirst).toBe(afterSecond);
  });

  it("sets a marker on `console` so external callers can detect the redirect", () => {
    expect(
      (console as unknown as Record<string, unknown>)[REDIRECT_FLAG],
    ).toBeUndefined();
    JsonLinesUI.redirectConsoleLogToStderr();
    expect((console as unknown as Record<string, unknown>)[REDIRECT_FLAG]).toBe(
      true,
    );
  });
});

describe("JsonLinesUI — modal prompts", () => {
  it("askApproval: writes ask-approval frame with id, resolves on matching response", async () => {
    let counter = 0;
    const { ui, frames } = makeUI({ generateId: () => `id-${++counter}` });
    const promise = ui.askApproval({
      question: "Continue?",
      kind: "plugin_audit",
      defaultChoice: "no",
    });

    expect(parseFrames(frames)).toEqual([
      {
        v: 1,
        t: "ask-approval",
        data: {
          id: "id-1",
          question: "Continue?",
          kind: "plugin_audit",
          defaultChoice: "no",
        },
      },
    ]);
    expect(ui.pendingCount).toBe(1);

    expect(ui.resolveApproval("id-1", "yes")).toBe(true);
    await expect(promise).resolves.toBe("yes");
    expect(ui.pendingCount).toBe(0);
  });

  it("askChoice: writes ask-choice frame, resolves with the answer object", async () => {
    let counter = 0;
    const { ui, frames } = makeUI({ generateId: () => `id-${++counter}` });
    const promise = ui.askChoice({
      question: "Pick one",
      choices: ["a", "b", "c"],
      allowFreeform: false,
    });
    expect(parseFrames(frames)).toEqual([
      {
        v: 1,
        t: "ask-choice",
        data: {
          id: "id-1",
          question: "Pick one",
          choices: ["a", "b", "c"],
          allowFreeform: false,
        },
      },
    ]);
    expect(ui.resolveChoice("id-1", { answer: "b", wasFreeform: false })).toBe(
      true,
    );
    await expect(promise).resolves.toEqual({
      answer: "b",
      wasFreeform: false,
    });
  });

  it("askText: writes ask-text frame, resolves with the trimmed answer string", async () => {
    let counter = 0;
    const { ui, frames } = makeUI({ generateId: () => `id-${++counter}` });
    const promise = ui.askText({ question: "Your name?" });
    expect(parseFrames(frames)).toEqual([
      {
        v: 1,
        t: "ask-text",
        data: { id: "id-1", question: "Your name?" },
      },
    ]);
    expect(ui.resolveText("id-1", "Simon")).toBe(true);
    await expect(promise).resolves.toBe("Simon");
  });

  it("askInline: writes ask-inline frame with the verbatim prompt string", async () => {
    let counter = 0;
    const { ui, frames } = makeUI({ generateId: () => `id-${++counter}` });
    const promise = ui.askInline("port (1-65535) [8080]: ");
    expect(parseFrames(frames)).toEqual([
      {
        v: 1,
        t: "ask-inline",
        data: { id: "id-1", prompt: "port (1-65535) [8080]: " },
      },
    ]);
    expect(ui.resolveInline("id-1", "3000")).toBe(true);
    await expect(promise).resolves.toBe("3000");
  });

  it("resolve* returns false (and does not throw) for unknown ids", () => {
    const { ui } = makeUI();
    expect(ui.resolveApproval("nope", "yes")).toBe(false);
    expect(ui.resolveChoice("nope", { answer: "x", wasFreeform: false })).toBe(
      false,
    );
    expect(ui.resolveText("nope", "x")).toBe(false);
    expect(ui.resolveInline("nope", "x")).toBe(false);
  });

  it("resolve* returns false when the kind doesn't match the pending prompt", async () => {
    let counter = 0;
    const { ui } = makeUI({ generateId: () => `id-${++counter}` });
    const promise = ui.askApproval({ question: "Continue?" });
    // Wrong-kind resolver must not consume the approval-typed
    // pending — the promise is still outstanding afterwards.
    expect(ui.resolveText("id-1", "yes")).toBe(false);
    expect(ui.pendingCount).toBe(1);
    expect(ui.resolveApproval("id-1", "yes")).toBe(true);
    await expect(promise).resolves.toBe("yes");
  });

  it("cancelAllPending: resolves every outstanding prompt with its safe default", async () => {
    let counter = 0;
    const { ui } = makeUI({ generateId: () => `id-${++counter}` });
    const approval = ui.askApproval({ question: "Continue?" });
    const choice = ui.askChoice({ question: "Pick", choices: ["a"] });
    const text = ui.askText({ question: "Name?" });
    const inline = ui.askInline("> ");
    expect(ui.pendingCount).toBe(4);
    ui.cancelAllPending();
    expect(ui.pendingCount).toBe(0);
    await expect(approval).resolves.toBe("no");
    await expect(choice).resolves.toEqual({ answer: "", wasFreeform: false });
    await expect(text).resolves.toBe("");
    await expect(inline).resolves.toBe("");
  });
});

describe("JsonLinesUI — robustness", () => {
  it("emit methods swallow sink exceptions (port contract: never throw)", () => {
    const ui = new JsonLinesUI({
      write: () => {
        throw new Error("pipe closed");
      },
    });
    // Every emit method must complete normally even if the sink
    // throws — the agent loop is otherwise hostage to a misbehaving
    // host pipe.
    expect(() => ui.emitText({ content: "hi" })).not.toThrow();
    expect(() => ui.emitReasoning({ content: "thinking" })).not.toThrow();
    expect(() => ui.emitReasoningTransition({})).not.toThrow();
    expect(() => ui.clearReasoningBuffer()).not.toThrow();
    expect(() => ui.setVerboseReasoning(true)).not.toThrow();
    expect(() => ui.renderMarkdown({ source: "x" })).not.toThrow();
    expect(() => ui.emitToolStart({ name: "n", callId: "c" })).not.toThrow();
    expect(() =>
      ui.emitToolResult({
        name: "n",
        callId: "c",
        status: "success",
        message: "ok",
      }),
    ).not.toThrow();
    expect(() => ui.beginTurn()).not.toThrow();
    expect(() =>
      ui.setActivity({ kind: "thinking", label: "Thinking..." }),
    ).not.toThrow();
    expect(() => ui.setActivity(null)).not.toThrow();
    expect(() => ui.setWindowTitle({ title: "x" })).not.toThrow();
    expect(() =>
      ui.emitNotification({
        level: "info",
        kind: "generic",
        message: "x",
      }),
    ).not.toThrow();
    expect(() => ui.emitUsage({})).not.toThrow();
  });

  it("drainPasteBuffer: resolves immediately (no readline to drain)", async () => {
    const { ui, frames } = makeUI();
    await expect(ui.drainPasteBuffer()).resolves.toBeUndefined();
    // Must not emit any frames — drain is best-effort and the
    // headless host owns its own input batching policy.
    expect(frames).toEqual([]);
  });

  it("uses the default randomUUID generator when none is injected", () => {
    const frames: string[] = [];
    const ui = new JsonLinesUI({ write: (c) => frames.push(c) });
    // Fire and forget; we only care that the id is a non-empty
    // string and that two prompts generate distinct ids.
    void ui.askText({ question: "a" });
    void ui.askText({ question: "b" });
    const parsed = parseFrames(frames);
    const id1 = (parsed[0]?.data as { id: string }).id;
    const id2 = (parsed[1]?.data as { id: string }).id;
    expect(typeof id1).toBe("string");
    expect(id1.length).toBeGreaterThan(0);
    expect(id1).not.toBe(id2);
  });
});
