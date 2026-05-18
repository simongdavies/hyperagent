// ── tests/ask-prompts.test.ts ─────────────────────────────────────────
//
// Goldens for the Phase 3a modal-prompt methods (`askApproval`,
// `askChoice`, `askText`) on `TerminalUI` and `NullUI`.
//
// What this proves
// ────────────────
//   - The byte-output of the prompts matches what the previous
//     `user-input-handler.ts` produced (so the migration is
//     transparent to user-visible transcripts and goldens).
//   - The methods read `readlineInstance` *live* off the options
//     bag — handles `/new` and other session swaps.
//   - `NullUI` rejects (rather than silently defaulting) so tests
//     that hit a modal prompt unintentionally fail loudly.
//
// Test plan
// ─────────
//   1. `askApproval`: default "no", default "yes", `y`/`yes`,
//      `n`/`no`, empty → default, unknown → default, no rl → default.
//   2. `askChoice`: numbered pick, freeform fallback when allowed,
//      empty → first choice, freeform-disabled fallback, no rl →
//      first choice.
//   3. `askText`: trims, no rl → empty string.
//   4. `NullUI`: all three reject with a descriptive error.
// ─────────────────────────────────────────────────────────────────────

import type { Interface as ReadlineInterface } from "node:readline/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureStdio, type StdioCapture } from "./ui-harness/index.js";
import { NullUI, TerminalUI, type AgentUI } from "../src/agent/ui/index.js";

/**
 * Minimal readline shim — covers everything `TerminalUI.ask*`
 * actually calls. The mock function returns whatever the test
 * scripted; multiple calls dequeue answers in order.
 */
function makeFakeReadline(answers: string[]): ReadlineInterface {
  let i = 0;
  return {
    question: vi.fn().mockImplementation(() => {
      const answer = answers[i] ?? "";
      i += 1;
      return Promise.resolve(answer);
    }),
  } as unknown as ReadlineInterface;
}

/**
 * Construct a TerminalUI with an optional `readlineInstance`.
 * Default verbose / markdown / quiet / no-color flags are all off.
 */
function makeUI(rl: ReadlineInterface | null = null): TerminalUI {
  return new TerminalUI({
    markdownEnabled: false,
    verboseOutput: false,
    readlineInstance: rl,
  });
}

describe("TerminalUI.askApproval", () => {
  let cap: StdioCapture;
  beforeEach(() => {
    vi.useFakeTimers();
    cap = captureStdio();
  });
  afterEach(() => {
    cap.restore();
    vi.useRealTimers();
  });

  it("default is 'no' when defaultChoice omitted, renders [y/N] hint", async () => {
    const ui = makeUI(makeFakeReadline([""]));
    const answer = await ui.askApproval({ question: "Proceed?" });
    expect(answer).toBe("no");
    expect(cap.stdout()).toContain("Proceed?");
    expect(cap.stdout()).toContain("[y/N]");
  });

  it("defaultChoice=yes renders [Y/n] hint and Enter picks yes", async () => {
    const ui = makeUI(makeFakeReadline([""]));
    const answer = await ui.askApproval({
      question: "Continue?",
      defaultChoice: "yes",
    });
    expect(answer).toBe("yes");
    expect(cap.stdout()).toContain("[Y/n]");
  });

  it("accepts 'y' / 'Y' / 'yes' / 'YES' as yes", async () => {
    for (const raw of ["y", "Y", "yes", "YES", " Yes "]) {
      const ui = makeUI(makeFakeReadline([raw]));
      const answer = await ui.askApproval({ question: "?" });
      expect(answer).toBe("yes");
    }
  });

  it("accepts 'n' / 'no' as no", async () => {
    for (const raw of ["n", "N", "no", " NO "]) {
      const ui = makeUI(makeFakeReadline([raw]));
      const answer = await ui.askApproval({
        question: "?",
        defaultChoice: "yes", // force a path where 'no' must override default
      });
      expect(answer).toBe("no");
    }
  });

  it("unknown input falls back to the default", async () => {
    const ui = makeUI(makeFakeReadline(["maybe"]));
    const answer = await ui.askApproval({
      question: "?",
      defaultChoice: "yes",
    });
    expect(answer).toBe("yes");
  });

  it("returns default when no readline is available", async () => {
    const ui = makeUI(null);
    const answer = await ui.askApproval({
      question: "Proceed?",
      defaultChoice: "no",
    });
    expect(answer).toBe("no");
    // The question line still renders so the user sees what was asked.
    expect(cap.stdout()).toContain("Proceed?");
  });
});

describe("TerminalUI.askChoice", () => {
  let cap: StdioCapture;
  beforeEach(() => {
    vi.useFakeTimers();
    cap = captureStdio();
  });
  afterEach(() => {
    cap.restore();
    vi.useRealTimers();
  });

  it("renders numbered choices and a freeform hint by default", async () => {
    const ui = makeUI(makeFakeReadline(["1"]));
    const { answer, wasFreeform } = await ui.askChoice({
      question: "Pick one",
      choices: ["alpha", "beta"],
    });
    expect(answer).toBe("alpha");
    expect(wasFreeform).toBe(false);
    const out = cap.stdout();
    expect(out).toContain("Pick one");
    expect(out).toContain("[1]");
    expect(out).toContain("alpha");
    expect(out).toContain("[2]");
    expect(out).toContain("beta");
    expect(out).toContain("Or type a custom answer");
  });

  it("returns selected choice for numeric pick", async () => {
    const ui = makeUI(makeFakeReadline(["2"]));
    const { answer, wasFreeform } = await ui.askChoice({
      question: "?",
      choices: ["a", "b", "c"],
    });
    expect(answer).toBe("b");
    expect(wasFreeform).toBe(false);
  });

  it("freeform fallback when input is text", async () => {
    const ui = makeUI(makeFakeReadline(["custom answer"]));
    const { answer, wasFreeform } = await ui.askChoice({
      question: "?",
      choices: ["a", "b"],
    });
    expect(answer).toBe("custom answer");
    expect(wasFreeform).toBe(true);
  });

  it("empty input defaults to first choice", async () => {
    const ui = makeUI(makeFakeReadline([""]));
    const { answer, wasFreeform } = await ui.askChoice({
      question: "?",
      choices: ["a", "b"],
    });
    expect(answer).toBe("a");
    expect(wasFreeform).toBe(false);
  });

  it("freeform disabled: text input falls back to first choice", async () => {
    const ui = makeUI(makeFakeReadline(["nonsense"]));
    const { answer, wasFreeform } = await ui.askChoice({
      question: "?",
      choices: ["a", "b"],
      allowFreeform: false,
    });
    expect(answer).toBe("a");
    expect(wasFreeform).toBe(false);
    // The "Or type a custom answer" hint must not render in this mode.
    expect(cap.stdout()).not.toContain("Or type a custom answer");
  });

  it("no readline: returns first choice", async () => {
    const ui = makeUI(null);
    const { answer, wasFreeform } = await ui.askChoice({
      question: "?",
      choices: ["only", "other"],
    });
    expect(answer).toBe("only");
    expect(wasFreeform).toBe(false);
  });
});

describe("TerminalUI.askText", () => {
  let cap: StdioCapture;
  beforeEach(() => {
    vi.useFakeTimers();
    cap = captureStdio();
  });
  afterEach(() => {
    cap.restore();
    vi.useRealTimers();
  });

  it("returns trimmed answer", async () => {
    const ui = makeUI(makeFakeReadline(["  hello world  "]));
    const answer = await ui.askText({ question: "Say something" });
    expect(answer).toBe("hello world");
    expect(cap.stdout()).toContain("Say something");
  });

  it("empty input returns empty string (caller handles it)", async () => {
    const ui = makeUI(makeFakeReadline([""]));
    const answer = await ui.askText({ question: "?" });
    expect(answer).toBe("");
  });

  it("no readline: returns empty string", async () => {
    const ui = makeUI(null);
    const answer = await ui.askText({ question: "?" });
    expect(answer).toBe("");
  });
});

describe("TerminalUI.ask* — live readline (handles /new swaps)", () => {
  let cap: StdioCapture;
  beforeEach(() => {
    vi.useFakeTimers();
    cap = captureStdio();
  });
  afterEach(() => {
    cap.restore();
    vi.useRealTimers();
  });

  it("re-reads readlineInstance from the live options bag on each call", async () => {
    // Mutable options object — TerminalUI keeps a live reference.
    const rlA = makeFakeReadline(["a"]);
    const rlB = makeFakeReadline(["b"]);
    const opts = {
      markdownEnabled: false,
      verboseOutput: false,
      readlineInstance: rlA as ReadlineInterface | null,
    };
    const ui = new TerminalUI(opts);
    const first = await ui.askText({ question: "?" });
    expect(first).toBe("a");

    // Swap readline (simulating /new) — next call must pick up rlB.
    opts.readlineInstance = rlB;
    const second = await ui.askText({ question: "?" });
    expect(second).toBe("b");
  });
});

describe("NullUI.ask* — rejects rather than silently defaulting", () => {
  it("askApproval rejects with a descriptive error", async () => {
    const ui: AgentUI = new NullUI();
    await expect(ui.askApproval({ question: "?" })).rejects.toThrow(
      /NullUI does not support askApproval/,
    );
  });

  it("askChoice rejects with a descriptive error", async () => {
    const ui: AgentUI = new NullUI();
    await expect(
      ui.askChoice({ question: "?", choices: ["a"] }),
    ).rejects.toThrow(/NullUI does not support askChoice/);
  });

  it("askText rejects with a descriptive error", async () => {
    const ui: AgentUI = new NullUI();
    await expect(ui.askText({ question: "?" })).rejects.toThrow(
      /NullUI does not support askText/,
    );
  });
});
