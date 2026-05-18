// ── tests/ipc-stdio-loop.test.ts ─────────────────────────────────────
//
// Unit tests for `runIpcStdioLoop` — the headless NDJSON driver that
// replaces the readline REPL when `--ipc-stdio` is passed.
//
// What this proves
// ────────────────
//   1. `user-input` frames invoke `processMessage` with the text and
//      stage any attached `attachments` onto `state.pendingAttachments`
//      before the call.
//   2. User-input frames are processed sequentially — a second frame
//      arriving while the first is in flight waits for the first to
//      finish before its `processMessage` is called.
//   3. Modal responses (`approval-response`/`choice-response`/
//      `text-response`/`inline-response`) route through to the UI's
//      `resolve*` API with the correct id and payload.
//   4. `abort` frames invoke the injected `triggerAbort` exactly once
//      per frame.
//   5. `shutdown` frames close the loop cleanly and cancel pending
//      modals.
//   6. Stdin EOF (without a shutdown frame) closes the loop and
//      cancels pending modals.
//   7. Malformed frames (bad JSON, missing tag, missing fields) emit
//      an `error` notification on the UI and the loop continues.
//   8. Attachments with missing `type` fields are dropped with a
//      warning, valid entries pass through verbatim.
// ─────────────────────────────────────────────────────────────────────

import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { runIpcStdioLoop } from "../src/agent/ipc-stdio-loop.js";
import { JsonLinesUI } from "../src/agent/ui/json-lines-ui.js";
import type { AgentState } from "../src/agent/state.js";

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Build a `Readable` that emits each entry of `lines` as a write
 * followed by `\n`, then EOF. Used to drive the loop deterministically.
 */
function makeStream(lines: string[]): Readable {
  return Readable.from(lines.map((l) => l + "\n"));
}

/**
 * Minimal `AgentState` subset the loop actually touches — keeps the
 * tests fast and isolated from the rest of state.ts.
 */
function makeMinimalState(): AgentState {
  return {
    pendingAttachments: [],
    // Other fields are not touched by `runIpcStdioLoop` — cast to
    // satisfy the type without dragging in the whole state factory.
  } as unknown as AgentState;
}

/**
 * Build the dependency record + a UI whose emitted frames we can
 * inspect. The `frames` array captures every write the UI makes
 * (turn-level errors, attachment-drop warnings, etc).
 */
function makeDeps(
  opts: {
    processMessage?: (text: string) => Promise<unknown>;
    triggerAbort?: () => void;
  } = {},
) {
  const frames: string[] = [];
  const ui = new JsonLinesUI({
    write: (chunk) => frames.push(chunk),
    generateId: () => "test-id",
  });
  const state = makeMinimalState();
  const processMessage =
    opts.processMessage ?? vi.fn(async (_text: string) => undefined);
  const triggerAbort = opts.triggerAbort ?? vi.fn(() => {});
  return { ui, state, processMessage, triggerAbort, frames };
}

// ── User input dispatch ──────────────────────────────────────────────

describe("runIpcStdioLoop — user-input dispatch", () => {
  it("calls processMessage with the frame's text", async () => {
    const calls: string[] = [];
    const { ui, state, processMessage, triggerAbort } = makeDeps({
      processMessage: async (text) => {
        calls.push(text);
      },
    });

    await runIpcStdioLoop(
      { ui, state, processMessage, triggerAbort },
      {
        input: makeStream([
          JSON.stringify({
            t: "user-input",
            data: { text: "hello world" },
          }),
        ]),
      },
    );

    expect(calls).toEqual(["hello world"]);
  });

  it("stages attachments onto state.pendingAttachments before processMessage", async () => {
    const seenAttachments: unknown[] = [];
    const { ui, state, triggerAbort } = makeDeps();
    const processMessage = vi.fn(async (_text: string) => {
      // Snapshot pendingAttachments at the moment processMessage runs
      seenAttachments.push([...state.pendingAttachments]);
    });

    const blob = {
      type: "blob",
      data: "iVBORw0KGgo=",
      mimeType: "image/png",
    };
    await runIpcStdioLoop(
      { ui, state, processMessage, triggerAbort },
      {
        input: makeStream([
          JSON.stringify({
            t: "user-input",
            data: { text: "see image", attachments: [blob] },
          }),
        ]),
      },
    );

    expect(seenAttachments).toEqual([[blob]]);
  });

  it("processes multiple user-input frames sequentially (one in flight at a time)", async () => {
    const order: string[] = [];
    let firstResolve: (() => void) | undefined;
    const firstStarted = new Promise<void>((r) => {
      firstResolve = r;
    });
    const processMessage = vi.fn(async (text: string) => {
      order.push(`start:${text}`);
      if (text === "first" && firstResolve) firstResolve();
      // Yield a tick so the second frame can be parsed before the
      // first turn finishes (proves the queue serialises).
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end:${text}`);
    });
    const { ui, state, triggerAbort } = makeDeps();

    await runIpcStdioLoop(
      { ui, state, processMessage, triggerAbort },
      {
        input: makeStream([
          JSON.stringify({ t: "user-input", data: { text: "first" } }),
          JSON.stringify({ t: "user-input", data: { text: "second" } }),
        ]),
      },
    );

    // Wait until the first turn has visibly started, then check
    // the order recorded the start → end → start → end pattern.
    await firstStarted;
    expect(order).toEqual([
      "start:first",
      "end:first",
      "start:second",
      "end:second",
    ]);
  });

  it("emits an error notification when user-input is missing text", async () => {
    const { ui, state, processMessage, triggerAbort, frames } = makeDeps();
    await runIpcStdioLoop(
      { ui, state, processMessage, triggerAbort },
      {
        input: makeStream([JSON.stringify({ t: "user-input", data: {} })]),
      },
    );
    expect(processMessage).not.toHaveBeenCalled();
    const parsed = frames.map((f) => JSON.parse(f.trim()));
    expect(
      parsed.some((p) => p.t === "notification" && p.data.level === "error"),
    ).toBe(true);
  });

  it("emits a turn-failed notification when processMessage throws", async () => {
    const processMessage = vi.fn(async (_text: string) => {
      throw new Error("turn boom");
    });
    const { ui, state, triggerAbort, frames } = makeDeps();
    await runIpcStdioLoop(
      { ui, state, processMessage, triggerAbort },
      {
        input: makeStream([
          JSON.stringify({ t: "user-input", data: { text: "hi" } }),
        ]),
      },
    );
    const errs = frames
      .map((f) => JSON.parse(f.trim()))
      .filter((p) => p.t === "notification" && p.data.level === "error");
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0].data.message).toMatch(/turn boom/);
  });
});

// ── Attachment sanitisation ──────────────────────────────────────────

describe("runIpcStdioLoop — attachment sanitisation", () => {
  it("drops attachments without a string `type` and warns once per drop", async () => {
    const seen: unknown[] = [];
    const processMessage = vi.fn(async (_text: string) => {
      seen.push([...state.pendingAttachments]);
    });
    const { ui, state, triggerAbort, frames } = makeDeps({ processMessage });
    await runIpcStdioLoop(
      { ui, state, processMessage, triggerAbort },
      {
        input: makeStream([
          JSON.stringify({
            t: "user-input",
            data: {
              text: "mixed",
              attachments: [
                { type: "file", path: "/tmp/a.txt", displayName: "a.txt" },
                { notAType: true }, // dropped
                null, // dropped
                { type: "blob", data: "AA==", mimeType: "image/png" },
              ],
            },
          }),
        ]),
      },
    );
    expect(seen).toEqual([
      [
        { type: "file", path: "/tmp/a.txt", displayName: "a.txt" },
        { type: "blob", data: "AA==", mimeType: "image/png" },
      ],
    ]);
    const warnings = frames
      .map((f) => JSON.parse(f.trim()))
      .filter((p) => p.t === "notification" && p.data.level === "warning");
    expect(warnings.length).toBe(2);
  });
});

// ── Modal response routing ───────────────────────────────────────────

describe("runIpcStdioLoop — modal response routing", () => {
  it("approval-response resolves a pending askApproval", async () => {
    const { ui, state, processMessage, triggerAbort } = makeDeps();
    // Pre-emit an approval request so the UI has a pending modal.
    const askPromise = ui.askApproval({
      question: "delete file?",
    });
    await runIpcStdioLoop(
      { ui, state, processMessage, triggerAbort },
      {
        input: makeStream([
          JSON.stringify({
            t: "approval-response",
            data: { id: "test-id", choice: "yes" },
          }),
        ]),
      },
    );
    await expect(askPromise).resolves.toBe("yes");
  });

  it("choice-response resolves a pending askChoice with wasFreeform", async () => {
    const { ui, state, processMessage, triggerAbort } = makeDeps();
    const askPromise = ui.askChoice({
      question: "pick one",
      choices: ["a", "b"],
      allowFreeform: true,
    });
    await runIpcStdioLoop(
      { ui, state, processMessage, triggerAbort },
      {
        input: makeStream([
          JSON.stringify({
            t: "choice-response",
            data: { id: "test-id", answer: "custom", wasFreeform: true },
          }),
        ]),
      },
    );
    await expect(askPromise).resolves.toEqual({
      answer: "custom",
      wasFreeform: true,
    });
  });

  it("text-response resolves a pending askText", async () => {
    const { ui, state, processMessage, triggerAbort } = makeDeps();
    const askPromise = ui.askText({ question: "name?" });
    await runIpcStdioLoop(
      { ui, state, processMessage, triggerAbort },
      {
        input: makeStream([
          JSON.stringify({
            t: "text-response",
            data: { id: "test-id", answer: "Simon" },
          }),
        ]),
      },
    );
    await expect(askPromise).resolves.toBe("Simon");
  });

  it("inline-response resolves a pending askInline", async () => {
    const { ui, state, processMessage, triggerAbort } = makeDeps();
    const askPromise = ui.askInline("name? ");
    await runIpcStdioLoop(
      { ui, state, processMessage, triggerAbort },
      {
        input: makeStream([
          JSON.stringify({
            t: "inline-response",
            data: { id: "test-id", answer: "Simon" },
          }),
        ]),
      },
    );
    await expect(askPromise).resolves.toBe("Simon");
  });

  it("emits an error notification for malformed approval-response", async () => {
    const { ui, state, processMessage, triggerAbort, frames } = makeDeps();
    await runIpcStdioLoop(
      { ui, state, processMessage, triggerAbort },
      {
        input: makeStream([
          JSON.stringify({
            t: "approval-response",
            data: { id: "test-id", choice: "maybe" },
          }),
        ]),
      },
    );
    const errs = frames
      .map((f) => JSON.parse(f.trim()))
      .filter((p) => p.t === "notification" && p.data.level === "error");
    expect(errs.length).toBe(1);
  });
});

// ── Abort + shutdown ─────────────────────────────────────────────────

describe("runIpcStdioLoop — abort + shutdown", () => {
  it("abort frame calls triggerAbort", async () => {
    const triggerAbort = vi.fn(() => {});
    const { ui, state, processMessage } = makeDeps({ triggerAbort });
    await runIpcStdioLoop(
      { ui, state, processMessage, triggerAbort },
      { input: makeStream([JSON.stringify({ t: "abort" })]) },
    );
    expect(triggerAbort).toHaveBeenCalledTimes(1);
  });

  it("shutdown frame exits cleanly and cancels pending modals", async () => {
    const { ui, state, processMessage, triggerAbort } = makeDeps();
    const askPromise = ui.askApproval({
      question: "delete?",
    });
    await runIpcStdioLoop(
      { ui, state, processMessage, triggerAbort },
      { input: makeStream([JSON.stringify({ t: "shutdown" })]) },
    );
    // cancelAllPending resolves askApproval with "no"
    await expect(askPromise).resolves.toBe("no");
  });

  it("stdin EOF without a shutdown frame still cancels pending modals", async () => {
    const { ui, state, processMessage, triggerAbort } = makeDeps();
    const askText = ui.askText({ question: "name?" });
    // Empty stream → immediate EOF
    await runIpcStdioLoop(
      { ui, state, processMessage, triggerAbort },
      { input: makeStream([]) },
    );
    // cancelAllPending resolves askText with ""
    await expect(askText).resolves.toBe("");
  });
});

// ── Frame parsing robustness ─────────────────────────────────────────

describe("runIpcStdioLoop — robustness", () => {
  it("skips empty lines", async () => {
    const { ui, state, triggerAbort, frames } = makeDeps();
    const processMessage = vi.fn(async (_t: string) => {});
    await runIpcStdioLoop(
      { ui, state, processMessage, triggerAbort },
      {
        input: makeStream([
          "",
          "   ",
          JSON.stringify({ t: "user-input", data: { text: "hi" } }),
        ]),
      },
    );
    expect(processMessage).toHaveBeenCalledTimes(1);
    // No spurious notifications for the blank lines
    const errs = frames
      .map((f) => JSON.parse(f.trim()))
      .filter((p) => p.t === "notification" && p.data.level === "error");
    expect(errs.length).toBe(0);
  });

  it("emits an error and continues after a malformed JSON line", async () => {
    const processMessage = vi.fn(async (_t: string) => {});
    const { ui, state, triggerAbort, frames } = makeDeps({ processMessage });
    await runIpcStdioLoop(
      { ui, state, processMessage, triggerAbort },
      {
        input: makeStream([
          "{not json",
          JSON.stringify({ t: "user-input", data: { text: "ok" } }),
        ]),
      },
    );
    expect(processMessage).toHaveBeenCalledWith("ok");
    const errs = frames
      .map((f) => JSON.parse(f.trim()))
      .filter((p) => p.t === "notification" && p.data.level === "error");
    expect(errs.length).toBe(1);
    expect(errs[0].data.message).toMatch(/malformed JSON/i);
  });

  it("emits an error and continues for frames missing the t tag", async () => {
    const processMessage = vi.fn(async (_t: string) => {});
    const { ui, state, triggerAbort, frames } = makeDeps({ processMessage });
    await runIpcStdioLoop(
      { ui, state, processMessage, triggerAbort },
      {
        input: makeStream([
          JSON.stringify({ data: { text: "no t" } }),
          JSON.stringify({ t: "user-input", data: { text: "ok" } }),
        ]),
      },
    );
    expect(processMessage).toHaveBeenCalledWith("ok");
    const errs = frames
      .map((f) => JSON.parse(f.trim()))
      .filter((p) => p.t === "notification" && p.data.level === "error");
    expect(errs.length).toBe(1);
  });

  it("emits an error and continues for unknown frame tags", async () => {
    const { ui, state, processMessage, triggerAbort, frames } = makeDeps();
    await runIpcStdioLoop(
      { ui, state, processMessage, triggerAbort },
      {
        input: makeStream([
          JSON.stringify({ t: "future-tag-from-newer-host", data: {} }),
        ]),
      },
    );
    const errs = frames
      .map((f) => JSON.parse(f.trim()))
      .filter((p) => p.t === "notification" && p.data.level === "error");
    expect(errs.length).toBe(1);
  });
});
