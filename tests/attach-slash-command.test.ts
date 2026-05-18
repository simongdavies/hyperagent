// ── tests/attach-slash-command.test.ts ───────────────────────────────
//
// Tests for the `/attach` slash command (Phase 6.5b):
//
//   1. `/attach`               — list current pending queue.
//   2. `/attach clear`         — drop the pending queue.
//   3. `/attach <path> [...]`  — resolve paths and push onto queue;
//      any failure leaves state untouched (atomic enqueue).
//
// `handleSlashCommand` is invoked directly; only `state` and `ui` are
// touched by the `/attach` case, so the rest of `SlashCommandDeps` is
// stubbed via a single `as unknown as SlashCommandDeps` cast.
//
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  handleSlashCommand,
  type SlashCommandDeps,
} from "../src/agent/slash-commands.js";
import type {
  NotificationPayload,
  NotificationLevel,
} from "../src/agent/ui/events.js";
import type { AgentUI } from "../src/agent/ui/port.js";
import { makeTestState } from "./ui-harness/test-state.js";

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Minimal `AgentUI` that records every `emitNotification` payload and
 * no-ops the rest. Implemented directly rather than subclassed from
 * `NullUI` because `NullUI`'s emit methods declare zero parameters
 * (a valid implementation of the interface but not a base class that
 * accepts a stricter override).
 */
class SpyUI implements AgentUI {
  readonly notifications: NotificationPayload[] = [];

  emitNotification(payload: NotificationPayload): void {
    this.notifications.push(payload);
  }

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
  setActivity(): void {}
  setWindowTitle(): void {}
  emitUsage(): void {}

  // Modal prompts are never invoked by `/attach` — reject loudly if
  // a test path hits one so the failure points straight at the bug.
  askApproval(): Promise<"yes" | "no"> {
    return Promise.reject(new Error("askApproval not expected in /attach"));
  }
  askChoice(): Promise<never> {
    return Promise.reject(new Error("askChoice not expected in /attach"));
  }
  askText(): Promise<string> {
    return Promise.reject(new Error("askText not expected in /attach"));
  }
  askInline(): Promise<string> {
    return Promise.reject(new Error("askInline not expected in /attach"));
  }

  // Paste-drain is a no-op for the headless test surface.
  drainPasteBuffer(): Promise<void> {
    return Promise.resolve();
  }

  /** Convenience for "the last notification's level matched X". */
  lastLevel(): NotificationLevel | undefined {
    return this.notifications[this.notifications.length - 1]?.level;
  }
  /** Convenience for "the last notification's message". */
  lastMessage(): string | undefined {
    return this.notifications[this.notifications.length - 1]?.message;
  }
}

/** Build the minimum `SlashCommandDeps` shape for `/attach`. */
function makeDeps(ui: AgentUI = new SpyUI()): SlashCommandDeps {
  const state = makeTestState();
  return {
    state,
    ui,
    // Everything below is unused by the `/attach` case but must
    // satisfy the destructuring at the top of `handleSlashCommand`.
  } as unknown as SlashCommandDeps;
}

// ── Fixtures ────────────────────────────────────────────────────────

let dir: string;
let fileA: string;
let fileB: string;
let subdir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hyperagent-attach-slash-"));
  fileA = join(dir, "a.png");
  fileB = join(dir, "b.csv");
  writeFileSync(fileA, "fakepng");
  writeFileSync(fileB, "x,y\n1,2\n");
  subdir = join(dir, "subdir");
  mkdirSync(subdir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── /attach (no args) — list ────────────────────────────────────────

describe("/attach — list pending", () => {
  it("reports 'No pending attachments' when queue is empty", async () => {
    const spy = new SpyUI();
    const deps = makeDeps(spy);
    const handled = await handleSlashCommand("/attach", deps);
    expect(handled).toBe(true);
    expect(spy.notifications).toHaveLength(1);
    expect(spy.notifications[0].level).toBe("info");
    expect(spy.notifications[0].kind).toBe("pending_attachments");
    expect(spy.notifications[0].message).toBe("No pending attachments.");
  });

  it("lists names and count when queue is non-empty", async () => {
    const spy = new SpyUI();
    const deps = makeDeps(spy);
    // Pre-populate the queue (simulating earlier `/attach foo` calls).
    deps.state.pendingAttachments.push(
      { type: "file", path: "/x/a.png", displayName: "a.png" },
      { type: "file", path: "/x/b.csv", displayName: "b.csv" },
    );

    await handleSlashCommand("/attach", deps);
    expect(spy.lastLevel()).toBe("info");
    expect(spy.lastMessage()).toBe("Pending attachments (2): a.png, b.csv");
    // Listing must not mutate the queue.
    expect(deps.state.pendingAttachments).toHaveLength(2);
  });
});

// ── /attach clear ───────────────────────────────────────────────────

describe("/attach clear", () => {
  it("emits a friendly message when nothing is queued", async () => {
    const spy = new SpyUI();
    const deps = makeDeps(spy);
    await handleSlashCommand("/attach clear", deps);
    expect(spy.lastLevel()).toBe("success");
    expect(spy.lastMessage()).toBe("No pending attachments to clear.");
  });

  it("drops the queue and reports the count", async () => {
    const spy = new SpyUI();
    const deps = makeDeps(spy);
    deps.state.pendingAttachments.push(
      { type: "file", path: "/x/a.png", displayName: "a.png" },
      { type: "file", path: "/x/b.csv", displayName: "b.csv" },
    );

    await handleSlashCommand("/attach clear", deps);
    expect(deps.state.pendingAttachments).toEqual([]);
    expect(spy.lastLevel()).toBe("success");
    expect(spy.lastMessage()).toBe("Cleared 2 pending attachments.");
  });

  it("uses the singular form when the count is one", async () => {
    const spy = new SpyUI();
    const deps = makeDeps(spy);
    deps.state.pendingAttachments.push({
      type: "file",
      path: "/x/a.png",
      displayName: "a.png",
    });

    await handleSlashCommand("/attach clear", deps);
    expect(spy.lastMessage()).toBe("Cleared 1 pending attachment.");
  });
});

// ── /attach <path> [<path> …] — enqueue ─────────────────────────────

describe("/attach <path> — enqueue", () => {
  it("queues a single file and emits a success line", async () => {
    const spy = new SpyUI();
    const deps = makeDeps(spy);
    await handleSlashCommand(`/attach ${fileA}`, deps);
    expect(deps.state.pendingAttachments).toEqual([
      { type: "file", path: fileA, displayName: "a.png" },
    ]);
    expect(spy.lastLevel()).toBe("success");
    expect(spy.lastMessage()).toBe("Queued attachment: a.png");
  });

  it("queues multiple files in order in a single call", async () => {
    const spy = new SpyUI();
    const deps = makeDeps(spy);
    await handleSlashCommand(`/attach ${fileA} ${fileB}`, deps);
    expect(
      deps.state.pendingAttachments.map((a) =>
        "displayName" in a ? a.displayName : "",
      ),
    ).toEqual(["a.png", "b.csv"]);
    expect(spy.lastLevel()).toBe("success");
    expect(spy.lastMessage()).toBe("Queued attachments: a.png, b.csv");
  });

  it("appends to an existing queue rather than replacing", async () => {
    const spy = new SpyUI();
    const deps = makeDeps(spy);
    deps.state.pendingAttachments.push({
      type: "file",
      path: "/preexisting",
      displayName: "preexisting",
    });
    await handleSlashCommand(`/attach ${fileA}`, deps);
    expect(
      deps.state.pendingAttachments.map((a) =>
        "displayName" in a ? a.displayName : "",
      ),
    ).toEqual(["preexisting", "a.png"]);
  });

  it("rejects a missing file with a /attach:-prefixed message and leaves the queue untouched", async () => {
    const spy = new SpyUI();
    const deps = makeDeps(spy);
    const missing = join(dir, "missing.png");
    await handleSlashCommand(`/attach ${missing}`, deps);
    expect(deps.state.pendingAttachments).toEqual([]);
    expect(spy.lastLevel()).toBe("error");
    expect(spy.lastMessage()).toMatch(/^\/attach:/);
    expect(spy.lastMessage()).toMatch(/cannot stat/);
  });

  it("rejects a directory with a clear message", async () => {
    const spy = new SpyUI();
    const deps = makeDeps(spy);
    await handleSlashCommand(`/attach ${subdir}`, deps);
    expect(deps.state.pendingAttachments).toEqual([]);
    expect(spy.lastLevel()).toBe("error");
    expect(spy.lastMessage()).toMatch(/^\/attach:/);
    expect(spy.lastMessage()).toMatch(/is a directory/);
  });

  it("is atomic — a single bad path discards every path in the call", async () => {
    const spy = new SpyUI();
    const deps = makeDeps(spy);
    const missing = join(dir, "missing.png");
    await handleSlashCommand(`/attach ${fileA} ${missing} ${fileB}`, deps);
    // Neither the good entry before, nor the good entry after, lands.
    expect(deps.state.pendingAttachments).toEqual([]);
    expect(spy.lastLevel()).toBe("error");
  });
});

// ── error-message prefix on the resolver itself ─────────────────────

describe("resolveFileAttachment — error prefix parameter", () => {
  it("defaults to '--attach:' when no source is supplied", async () => {
    const { resolveFileAttachment } =
      await import("../src/agent/attachments.js");
    expect(() => resolveFileAttachment(join(dir, "nope"))).toThrow(
      /^--attach:/,
    );
  });

  it("uses the caller-supplied prefix verbatim", async () => {
    const { resolveFileAttachment } =
      await import("../src/agent/attachments.js");
    expect(() => resolveFileAttachment(join(dir, "nope"), "/attach")).toThrow(
      /^\/attach:/,
    );
  });
});
