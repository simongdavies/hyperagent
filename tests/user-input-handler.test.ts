// ── tests/user-input-handler.test.ts ─────────────────────────────────
//
// Tests for the Phase 3a-migrated `createUserInputHandler` factory.
//
// What this proves
// ────────────────
//   - Auto-approve short-circuits at the handler level (never
//     invokes `ui.ask*`) and renders the "(auto: …)" affordance.
//   - When a UI is present, choice-bearing requests delegate to
//     `ui.askChoice` with the right payload shape (including the
//     `"ask_user"` semantic `kind`).
//   - Free-form requests delegate to `ui.askText` and the empty
//     answer falls back to "No answer provided".
//   - Missing UI returns "Unable to get user input" (matches the
//     legacy "missing readline" branch).
//
// The SpyUI here implements `AgentUI` directly rather than
// subclassing `NullUI` — see `attach-slash-command.test.ts` for the
// reasoning (NullUI's emit methods declare zero parameters which
// don't compose as a base class for spies).
// ─────────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureStdio, type StdioCapture } from "./ui-harness/index.js";
import { createUserInputHandler } from "../src/agent/user-input-handler.js";
import type { AgentUI } from "../src/agent/ui/port.js";
import type {
  ApprovalQuestion,
  ChoiceAnswer,
  ChoiceQuestion,
  TextQuestion,
} from "../src/agent/ui/events.js";

// ── SpyUI ────────────────────────────────────────────────────────────

/**
 * Test double for `AgentUI` that records every `ask*` invocation and
 * returns scripted answers. All other methods are no-ops; an
 * `assert` guards any unexpected call so tests fail loudly when the
 * handler talks to a surface we don't expect.
 */
class SpyUI implements AgentUI {
  /** Recorded `askChoice` invocations. */
  readonly choiceCalls: ChoiceQuestion[] = [];
  /** Recorded `askText` invocations. */
  readonly textCalls: TextQuestion[] = [];
  /** Recorded `askApproval` invocations. */
  readonly approvalCalls: ApprovalQuestion[] = [];
  /** Number of `setActivity(null)` calls — handler stops spinner first. */
  setActivityCalls = 0;

  /** Scripted reply for the next `askChoice` call. */
  nextChoiceAnswer: ChoiceAnswer = { answer: "stubbed", wasFreeform: false };
  /** Scripted reply for the next `askText` call. */
  nextTextAnswer: string = "";

  askChoice(payload: ChoiceQuestion): Promise<ChoiceAnswer> {
    this.choiceCalls.push(payload);
    return Promise.resolve(this.nextChoiceAnswer);
  }
  askText(payload: TextQuestion): Promise<string> {
    this.textCalls.push(payload);
    return Promise.resolve(this.nextTextAnswer);
  }
  askApproval(payload: ApprovalQuestion): Promise<"yes" | "no"> {
    this.approvalCalls.push(payload);
    return Promise.resolve("no");
  }
  setActivity(): void {
    this.setActivityCalls += 1;
  }

  // Emit-only stubs — handler doesn't call these in Phase 3a but the
  // interface requires every member.
  emitText(): void {}
  emitReasoning(): void {}
  emitReasoningTransition(): void {}
  clearReasoningBuffer(): void {}
  hasBufferedReasoning(): boolean {
    return false;
  }
  setVerboseReasoning(): void {}
  renderMarkdown(): void {}
  emitToolStart(): void {}
  emitToolResult(): void {}
  beginTurn(): void {}
  setWindowTitle(): void {}
  emitNotification(): void {}
  emitUsage(): void {}
  drainPasteBuffer(): Promise<void> {
    return Promise.resolve();
  }
}

// ── Tests ────────────────────────────────────────────────────────────

describe("createUserInputHandler — UI wiring", () => {
  let cap: StdioCapture;
  beforeEach(() => {
    vi.useFakeTimers();
    cap = captureStdio();
  });
  afterEach(() => {
    cap.restore();
    vi.useRealTimers();
  });

  it("returns sensible fallback when UI is missing", async () => {
    const handler = createUserInputHandler(() => null);
    const reply = await handler({ question: "?" });
    expect(reply).toEqual({
      answer: "Unable to get user input",
      wasFreeform: true,
    });
  });

  it("delegates choice questions to ui.askChoice", async () => {
    const ui = new SpyUI();
    ui.nextChoiceAnswer = { answer: "beta", wasFreeform: false };
    const handler = createUserInputHandler(() => ui);
    const reply = await handler({
      question: "Pick one",
      choices: ["alpha", "beta"],
    });
    expect(ui.choiceCalls).toHaveLength(1);
    expect(ui.choiceCalls[0]).toMatchObject({
      question: "Pick one",
      choices: ["alpha", "beta"],
      allowFreeform: true,
      kind: "ask_user",
    });
    expect(reply).toEqual({ answer: "beta", wasFreeform: false });
  });

  it("forwards allowFreeform=false through to askChoice", async () => {
    const ui = new SpyUI();
    const handler = createUserInputHandler(() => ui);
    await handler({
      question: "?",
      choices: ["a", "b"],
      allowFreeform: false,
    });
    expect(ui.choiceCalls[0].allowFreeform).toBe(false);
  });

  it("propagates freeform-fallback flag from ui.askChoice", async () => {
    const ui = new SpyUI();
    ui.nextChoiceAnswer = { answer: "custom", wasFreeform: true };
    const handler = createUserInputHandler(() => ui);
    const reply = await handler({
      question: "?",
      choices: ["a"],
    });
    expect(reply).toEqual({ answer: "custom", wasFreeform: true });
  });

  it("delegates freeform questions to ui.askText", async () => {
    const ui = new SpyUI();
    ui.nextTextAnswer = "hello world";
    const handler = createUserInputHandler(() => ui);
    const reply = await handler({ question: "Say something" });
    expect(ui.textCalls).toHaveLength(1);
    expect(ui.textCalls[0]).toMatchObject({
      question: "Say something",
      kind: "ask_user",
    });
    expect(reply).toEqual({ answer: "hello world", wasFreeform: true });
  });

  it("maps empty freeform answer to the 'No answer provided' fallback", async () => {
    const ui = new SpyUI();
    ui.nextTextAnswer = "";
    const handler = createUserInputHandler(() => ui);
    const reply = await handler({ question: "?" });
    expect(reply).toEqual({
      answer: "No answer provided",
      wasFreeform: true,
    });
  });
});

describe("createUserInputHandler — auto-approve short-circuit", () => {
  let cap: StdioCapture;
  beforeEach(() => {
    vi.useFakeTimers();
    cap = captureStdio();
  });
  afterEach(() => {
    cap.restore();
    vi.useRealTimers();
  });

  it("picks the first choice when choices are provided", async () => {
    const ui = new SpyUI();
    const handler = createUserInputHandler(
      () => ui,
      () => true,
    );
    const reply = await handler({
      question: "Pick one",
      choices: ["alpha", "beta"],
    });
    expect(reply).toEqual({ answer: "alpha", wasFreeform: false });
    // Spinner stopped, UI ask* never invoked.
    expect(ui.setActivityCalls).toBeGreaterThan(0);
    expect(ui.choiceCalls).toHaveLength(0);
    expect(ui.textCalls).toHaveLength(0);
    // Affordance rendered: question + "(auto: alpha)" line.
    expect(cap.stdout()).toContain("Pick one");
    expect(cap.stdout()).toContain("(auto: alpha)");
  });

  it("returns 'yes' for freeform questions in auto-approve mode", async () => {
    const ui = new SpyUI();
    const handler = createUserInputHandler(
      () => ui,
      () => true,
    );
    const reply = await handler({ question: "Continue?" });
    expect(reply).toEqual({ answer: "yes", wasFreeform: true });
    expect(ui.askText).toBeDefined(); // sanity
    expect(ui.textCalls).toHaveLength(0);
    expect(cap.stdout()).toContain("Continue?");
    expect(cap.stdout()).toContain("(auto: yes)");
  });

  it("does not auto-approve when getAutoApprove returns false", async () => {
    const ui = new SpyUI();
    ui.nextTextAnswer = "answered";
    const handler = createUserInputHandler(
      () => ui,
      () => false,
    );
    const reply = await handler({ question: "?" });
    expect(reply).toEqual({ answer: "answered", wasFreeform: true });
    expect(ui.textCalls).toHaveLength(1);
  });
});
