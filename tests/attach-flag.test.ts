// ── tests/attach-flag.test.ts ────────────────────────────────────────
//
// Tests for the `--attach FILE` CLI flag plumbing (Phase 6.5a):
//
//   1. `parseCliArgs(...)` records each `--attach FILE` occurrence into
//      `cli.attach: string[]`, preserving order across repeats.
//   2. `resolveFileAttachment(input)` resolves a user-supplied path
//      to a typed `{ type: "file", path, displayName }` attachment,
//      rejecting missing files and directories with clear messages.
//   3. `sendAndWaitWithKeepAlive(..., attachments?)` forwards the
//      attachments array into `session.send()` only when non-empty,
//      preserving byte-identical input to the SDK for non-attachment
//      sessions.
//
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CopilotSession } from "@github/copilot-sdk";

import { parseCliArgs } from "../src/agent/cli-parser.js";
import {
  resolveFileAttachment,
  resolveFileAttachments,
  type SessionAttachment,
} from "../src/agent/attachments.js";
import {
  sendAndWaitWithKeepAlive,
  clearKeepAliveState,
  type EventHandlerDeps,
} from "../src/agent/event-handler.js";
import { NullUI } from "../src/agent/ui/null-ui.js";
import type { AgentState } from "../src/agent/state.js";

// ── Parser ──────────────────────────────────────────────────────────

describe("--attach CLI flag (parser)", () => {
  it("defaults to an empty array", () => {
    expect(parseCliArgs([]).attach).toEqual([]);
  });

  it("captures a single --attach path", () => {
    expect(parseCliArgs(["--attach", "a.png"]).attach).toEqual(["a.png"]);
  });

  it("captures repeated --attach paths in order", () => {
    expect(
      parseCliArgs(["--attach", "a.png", "--attach", "b.csv"]).attach,
    ).toEqual(["a.png", "b.csv"]);
  });

  it("coexists with other flags without interference", () => {
    const cfg = parseCliArgs([
      "--attach",
      "a.png",
      "--debug",
      "--attach",
      "b.csv",
      "--verbose",
    ]);
    expect(cfg.attach).toEqual(["a.png", "b.csv"]);
    expect(cfg.debug).toBe(true);
    expect(cfg.verbose).toBe(true);
  });
});

// ── Resolver ────────────────────────────────────────────────────────

describe("resolveFileAttachment", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hyperagent-attach-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves an existing file to an absolute-path file attachment", () => {
    const p = join(dir, "hello.png");
    writeFileSync(p, "x");
    expect(resolveFileAttachment(p)).toEqual({
      type: "file",
      path: p,
      displayName: "hello.png",
    });
  });

  it("rejects a missing file with the --attach: prefix", () => {
    expect(() => resolveFileAttachment(join(dir, "missing.png"))).toThrow(
      /^--attach:/,
    );
  });

  it("rejects a directory with a clear message", () => {
    const sub = join(dir, "sub");
    mkdirSync(sub);
    expect(() => resolveFileAttachment(sub)).toThrow(/is a directory/);
  });

  it("preserves input order across multiple paths", () => {
    const a = join(dir, "a.txt");
    const b = join(dir, "b.txt");
    writeFileSync(a, "");
    writeFileSync(b, "");
    const list = resolveFileAttachments([a, b]);
    expect(list.map((x) => ("displayName" in x ? x.displayName : ""))).toEqual([
      "a.txt",
      "b.txt",
    ]);
  });
});

// ── Wiring through session.send ─────────────────────────────────────

interface TestDeps extends EventHandlerDeps {
  sent: unknown[];
  session: CopilotSession;
}

/**
 * Build a `EventHandlerDeps` whose session records every
 * `send()` opts object and returns a never-resolving promise (so
 * the outer `sendAndWaitWithKeepAlive` promise stays pending —
 * we assert the synchronous `send` call effect, then clear the
 * keep-alive timer to free the test).
 */
function makeDeps(): TestDeps {
  const sent: unknown[] = [];
  const session: CopilotSession = {
    send: (opts: unknown) => {
      sent.push(opts);
      return new Promise(() => {});
    },
  } as unknown as CopilotSession;
  const state = {
    pendingResolve: null,
    pendingReject: null,
    lastAssistantMessage: undefined,
    waitingForUserInput: false,
    keepAliveTimeoutId: null,
    sendTimeoutOverride: null,
    inactivityRetryCount: 0,
    activeSession: session,
  } as unknown as AgentState;
  const deps: EventHandlerDeps = {
    state,
    ui: new NullUI(),
    sandbox: {} as never,
    // Use a deliberately huge timeout so the keep-alive nudge never
    // fires during the test. We clear the timer in cleanup.
    SEND_TIMEOUT_MS: 60_000_000,
    MAX_INACTIVITY_RETRIES: 0,
    debugLog: () => {},
  };
  return Object.assign(deps, { sent, session });
}

describe("sendAndWaitWithKeepAlive — attachment forwarding", () => {
  it("sends only { prompt } when no attachments are provided", () => {
    const d = makeDeps();
    try {
      void sendAndWaitWithKeepAlive(d.session, "hi", d);
      expect(d.sent).toEqual([{ prompt: "hi" }]);
    } finally {
      clearKeepAliveState(d);
    }
  });

  it("sends only { prompt } when attachments is the empty array", () => {
    const d = makeDeps();
    try {
      void sendAndWaitWithKeepAlive(d.session, "hi", d, []);
      expect(d.sent).toEqual([{ prompt: "hi" }]);
    } finally {
      clearKeepAliveState(d);
    }
  });

  it("forwards a single file attachment to session.send", () => {
    const d = makeDeps();
    const attachments: SessionAttachment[] = [
      { type: "file", path: "/abs/foo.png", displayName: "foo.png" },
    ];
    try {
      void sendAndWaitWithKeepAlive(d.session, "describe this", d, attachments);
      expect(d.sent).toEqual([{ prompt: "describe this", attachments }]);
    } finally {
      clearKeepAliveState(d);
    }
  });

  it("preserves attachment order in the forwarded array", () => {
    const d = makeDeps();
    const atts: SessionAttachment[] = [
      { type: "file", path: "/a.png", displayName: "a.png" },
      { type: "file", path: "/b.csv", displayName: "b.csv" },
    ];
    try {
      void sendAndWaitWithKeepAlive(d.session, "x", d, atts);
      expect(d.sent[0]).toMatchObject({ attachments: atts });
    } finally {
      clearKeepAliveState(d);
    }
  });
});
