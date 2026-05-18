// ── tests/slash-command-prompts.test.ts ─────────────────────────────
//
// Tests for the Phase 3b slash-command prompt migration: every
// `rl.question` call site in `src/agent/slash-commands.ts` has been
// routed through `AgentUI.askApproval` / `askChoice` / `askText`.
//
// Three layers of coverage in this file:
//
//   1. A structural regression guard — `rl.question` must not appear
//      in `slash-commands.ts` source. Cheap, catches accidental
//      re-introductions if a future PR adds another prompt without
//      using the port.
//   2. Targeted `/skills delete` tests — the destructive-confirmation
//      site. Auto-approve, "yes" reply, "no" reply.
//   3. Targeted `/resume` picker tests — the freeform text-prompt
//      site. Empty answer (cancel) plus payload shape.
//
// The heavier plugin/audit/mcp prompt sites are migrated and
// typechecked but covered only by the structural guard for now;
// their bespoke harnesses live in a future phase.
// ─────────────────────────────────────────────────────────────────────

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type {
  ApprovalQuestion,
  TextQuestion,
  ChoiceQuestion,
  ChoiceAnswer,
  NotificationPayload,
} from "../src/agent/ui/events.js";
import type { AgentUI } from "../src/agent/ui/port.js";
import type { SlashCommandDeps } from "../src/agent/slash-commands.js";
import { makeTestState } from "./ui-harness/test-state.js";
import type { Interface as ReadlineInterface } from "node:readline/promises";

// ── 1. Structural regression guard ──────────────────────────────────

describe("slash-commands.ts — Phase 3b structural invariants", () => {
  it("contains zero `rl.question(` calls", () => {
    const src = readFileSync(
      new URL("../src/agent/slash-commands.ts", import.meta.url),
      "utf8",
    );
    // Strip comments to avoid the `// …rl.question…` historical
    // references in the docstrings tripping the guard.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(stripped).not.toMatch(/\brl\.question\s*\(/);
  });

  it("routes prompts through `ui.askApproval` / `askChoice` / `askText`", () => {
    const src = readFileSync(
      new URL("../src/agent/slash-commands.ts", import.meta.url),
      "utf8",
    );
    // Every prompt site should be visible to the structural guard
    // as a call on the `ui` port — keeps reviewers from missing a
    // newly-added prompt that bypasses the migration.
    expect(src).toMatch(/ui\.askApproval\s*\(/);
    expect(src).toMatch(/ui\.askChoice\s*\(/);
    expect(src).toMatch(/ui\.askText\s*\(/);
  });
});

// ── 2. /skills delete ───────────────────────────────────────────────
//
// `/skills delete <name>` reads `userSkillExists()` and then prompts
// before calling `deleteUserSkill()`. Both functions resolve their
// path from `HYPERAGENT_USER_SKILLS_DIR` at module load — tests must
// reset modules after pinning the env var, mirroring the pattern in
// `tests/skill-writer.test.ts`.
// ────────────────────────────────────────────────────────────────────

/** Minimal `AgentUI` recording every prompt call for assertions. */
function makeSpyUI(
  opts: {
    approval?: "yes" | "no" | (() => "yes" | "no");
    text?: string | (() => string);
    choice?: ChoiceAnswer | (() => ChoiceAnswer);
  } = {},
): AgentUI & {
  approvals: ApprovalQuestion[];
  texts: TextQuestion[];
  choices: ChoiceQuestion[];
  notifications: NotificationPayload[];
} {
  const approvals: ApprovalQuestion[] = [];
  const texts: TextQuestion[] = [];
  const choices: ChoiceQuestion[] = [];
  const notifications: NotificationPayload[] = [];

  const askApproval = vi.fn(
    async (p: ApprovalQuestion): Promise<"yes" | "no"> => {
      approvals.push(p);
      const reply =
        typeof opts.approval === "function" ? opts.approval() : opts.approval;
      return reply ?? "no";
    },
  );
  const askText = vi.fn(async (p: TextQuestion): Promise<string> => {
    texts.push(p);
    const reply = typeof opts.text === "function" ? opts.text() : opts.text;
    return reply ?? "";
  });
  const askChoice = vi.fn(async (p: ChoiceQuestion): Promise<ChoiceAnswer> => {
    choices.push(p);
    const reply =
      typeof opts.choice === "function" ? opts.choice() : opts.choice;
    return reply ?? { answer: p.choices[0] ?? "", wasFreeform: false };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ui: any = {
    askApproval,
    askText,
    askChoice,
    emitText() {},
    emitReasoning() {},
    emitReasoningTransition() {},
    clearReasoningBuffer() {},
    hasBufferedReasoning() {
      return false;
    },
    setVerboseReasoning() {},
    renderMarkdown() {},
    emitToolStart() {},
    emitToolResult() {},
    beginTurn() {},
    setActivity() {},
    setWindowTitle() {},
    emitUsage() {},
    emitNotification(payload: NotificationPayload) {
      notifications.push(payload);
    },
  };
  ui.approvals = approvals;
  ui.texts = texts;
  ui.choices = choices;
  ui.notifications = notifications;
  return ui;
}

describe("/skills delete — destructive confirmation prompt", () => {
  let tempSkillsDir: string;
  let savedEnv: string | undefined;
  type SlashCommands = typeof import("../src/agent/slash-commands.js");
  let slash: SlashCommands;

  beforeEach(async () => {
    tempSkillsDir = mkdtempSync(join(tmpdir(), "slash-prompts-skills-"));
    // Seed a user skill `demo` that `/skills delete demo` can target.
    const demoDir = join(tempSkillsDir, "demo");
    mkdirSync(demoDir, { recursive: true });
    writeFileSync(
      join(demoDir, "SKILL.md"),
      `---\nname: demo\ndescription: Test skill\ntriggers: ["demo"]\nallowedTools: []\n---\nBody.\n`,
      "utf8",
    );

    savedEnv = process.env.HYPERAGENT_USER_SKILLS_DIR;
    process.env.HYPERAGENT_USER_SKILLS_DIR = tempSkillsDir;
    vi.resetModules();
    slash = await import("../src/agent/slash-commands.js");
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.HYPERAGENT_USER_SKILLS_DIR;
    else process.env.HYPERAGENT_USER_SKILLS_DIR = savedEnv;
    rmSync(tempSkillsDir, { recursive: true, force: true });
  });

  function makeDeps(ui: AgentUI, autoApprove = false): SlashCommandDeps {
    const state = makeTestState({ autoApprove });
    return {
      state,
      ui,
      drainAndWarn: vi.fn(async () => {}),
    } as unknown as SlashCommandDeps;
  }

  it("prompts via askApproval with kind=skill_delete and defaultChoice=no", async () => {
    const ui = makeSpyUI({ approval: "no" });
    const deps = makeDeps(ui);

    const handled = await slash.handleSlashCommand(
      "/skills delete demo",
      null as unknown as ReadlineInterface,
      deps,
    );

    expect(handled).toBe(true);
    expect(ui.approvals).toHaveLength(1);
    expect(ui.approvals[0].kind).toBe("skill_delete");
    expect(ui.approvals[0].defaultChoice).toBe("no");
    expect(ui.approvals[0].question).toMatch(/Delete user skill/);
    expect(ui.approvals[0].question).toMatch(/demo/);
    // "no" reply — skill must still exist after the call.
    const { userSkillExists } = await import("../src/agent/skill-writer.js");
    expect(userSkillExists("demo")).toBe(true);
  });

  it("deletes the skill when the user answers yes", async () => {
    const ui = makeSpyUI({ approval: "yes" });
    const deps = makeDeps(ui);

    await slash.handleSlashCommand(
      "/skills delete demo",
      null as unknown as ReadlineInterface,
      deps,
    );

    const { userSkillExists } = await import("../src/agent/skill-writer.js");
    expect(userSkillExists("demo")).toBe(false);
  });

  it("auto-approve short-circuits the prompt and deletes immediately", async () => {
    const ui = makeSpyUI();
    const deps = makeDeps(ui, /* autoApprove */ true);

    await slash.handleSlashCommand(
      "/skills delete demo",
      null as unknown as ReadlineInterface,
      deps,
    );

    expect(ui.approvals).toHaveLength(0);
    expect((ui.askApproval as Mock).mock.calls).toHaveLength(0);
    const { userSkillExists } = await import("../src/agent/skill-writer.js");
    expect(userSkillExists("demo")).toBe(false);
  });

  it("calls drainAndWarn before the prompt to flush pasted input", async () => {
    const ui = makeSpyUI({ approval: "no" });
    const deps = makeDeps(ui);

    await slash.handleSlashCommand(
      "/skills delete demo",
      null as unknown as ReadlineInterface,
      deps,
    );

    expect(deps.drainAndWarn).toHaveBeenCalledTimes(1);
  });
});

// ── 3. /resume picker ───────────────────────────────────────────────
//
// The session picker prompts with askText (kind=resume_session) when
// no session id is given on the command line and the user has at
// least one previous session.  We exercise the cancel path (empty
// answer) which exits cleanly without touching the session lifecycle.
// ────────────────────────────────────────────────────────────────────

describe("/resume — session picker text prompt", () => {
  type SlashCommands = typeof import("../src/agent/slash-commands.js");
  let slash: SlashCommands;

  beforeEach(async () => {
    vi.resetModules();
    slash = await import("../src/agent/slash-commands.js");
  });

  function makeDeps(
    ui: AgentUI,
    sessions: Array<{
      sessionId: string;
      modifiedTime?: string;
      summary?: string;
    }>,
  ): SlashCommandDeps {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const copilotClient: any = {
      listSessions: vi.fn(async () => sessions),
    };
    const state = makeTestState({
      copilotClient,
      activeSession: null,
    });
    return {
      state,
      ui,
      drainAndWarn: vi.fn(async () => {}),
    } as unknown as SlashCommandDeps;
  }

  it("prompts via askText with kind=resume_session", async () => {
    const ui = makeSpyUI({ text: "" });
    const deps = makeDeps(ui, [
      {
        sessionId: "hyperagent-abc-123",
        modifiedTime: new Date().toISOString(),
        summary: "Test session",
      },
    ]);

    const handled = await slash.handleSlashCommand(
      "/resume",
      null as unknown as ReadlineInterface,
      deps,
    );

    expect(handled).toBe(true);
    expect(ui.texts).toHaveLength(1);
    expect(ui.texts[0].kind).toBe("resume_session");
    expect(ui.texts[0].question).toMatch(/Enter number .* or session ID/);
  });

  it("cancels cleanly when the user submits an empty answer", async () => {
    const ui = makeSpyUI({ text: "" });
    const deps = makeDeps(ui, [
      {
        sessionId: "hyperagent-abc-123",
        modifiedTime: new Date().toISOString(),
        summary: "Test session",
      },
    ]);

    const handled = await slash.handleSlashCommand(
      "/resume",
      null as unknown as ReadlineInterface,
      deps,
    );

    expect(handled).toBe(true);
    // Empty answer = cancel; no resumeSession call.
    // (`activeSession` stays null on the state we built.)
    expect(deps.state.activeSession).toBeNull();
  });
});
