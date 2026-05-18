// ── tests/drain-paste-buffer.test.ts ─────────────────────────────────
//
// Goldens for `AgentUI.drainPasteBuffer()` introduced in Phase 3c.
//
// What this proves
// ────────────────
//   - `TerminalUI.drainPasteBuffer` is byte-for-byte equivalent to
//     the pre-Phase-3c `drainAndWarn(rl)` helper that lived in
//     `src/agent/index.ts` — same grace window, same line-stealing
//     behaviour, same warning text and preview format.
//   - The method reads `readlineInstance` and `lastUserInputTime`
//     *live* off the options bag, so a session swap (`/new`) or a
//     fresh paste timestamp updates take effect on the next call
//     without re-constructing the UI.
//   - `NullUI.drainPasteBuffer` is a no-op (headless surfaces own
//     no paste buffer).
//
// Test plan
// ─────────
//   1. No readline → resolves cleanly, no output.
//   2. Within `DRAIN_GRACE_MS` of last user input → skip drain,
//      no warning rendered.
//   3. Past grace window, empty buffer, no buffered `line` events →
//      resolves quietly, no warning.
//   4. Partial line sitting in `internal.line` → captured, cleared,
//      warning rendered.
//   5. Buffered `line` events flush during the quiet window →
//      captured, warning rendered.
//   6. > preview-count (2) discarded lines → "and N more" tail.
//   7. Live readline swap mid-session → next call uses the new rl.
//   8. `NullUI.drainPasteBuffer()` resolves with no side effects.
// ─────────────────────────────────────────────────────────────────────

import { EventEmitter } from "node:events";
import type { Interface as ReadlineInterface } from "node:readline/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureStdio, type StdioCapture } from "./ui-harness/index.js";
import { NullUI, TerminalUI } from "../src/agent/ui/index.js";

/**
 * Mutable options bag — TerminalUI reads fields live each call, so
 * tests can flip `readlineInstance` or `lastUserInputTime` between
 * calls and observe the change without re-constructing the UI.
 */
interface MutableOpts {
  markdownEnabled: boolean;
  verboseOutput: boolean;
  readlineInstance?: ReadlineInterface | null;
  lastUserInputTime?: number;
}

/**
 * Fake readline that satisfies the slice of the `Interface` API
 * `drainPasteBuffer` touches: `on`/`off` for `line` events, plus
 * the writable internal `line` / `cursor` buffer slots that the
 * drain helper steals via the documented unsafe cast.
 */
class FakeReadline extends EventEmitter {
  /** Mirrors readline's internal partial-line buffer. */
  line: string = "";
  /** Mirrors readline's internal cursor position. */
  cursor: number = 0;

  /** Emit a buffered `line` event synchronously — the drain helper's
   *  quiet-window timer resets on each one. */
  pushLine(text: string): void {
    this.emit("line", text);
  }
}

/** Helpers — separate the cast from the test bodies. */
function asRl(fake: FakeReadline): ReadlineInterface {
  return fake as unknown as ReadlineInterface;
}

/**
 * Build a `TerminalUI` with a mutable options bag so individual
 * tests can mutate `readlineInstance` / `lastUserInputTime` between
 * drain calls and assert the UI honours the new values.
 */
function makeUI(initial: MutableOpts): {
  ui: TerminalUI;
  opts: MutableOpts;
} {
  const opts: MutableOpts = { ...initial };
  return { ui: new TerminalUI(opts), opts };
}

describe("TerminalUI.drainPasteBuffer", () => {
  let cap: StdioCapture;
  beforeEach(() => {
    // Real timers — the drain helper relies on real `setTimeout`
    // edge ordering with EventEmitter `line` callbacks. Faking
    // timers would force every test to dance around the quiet
    // window manually, which buys nothing here.
    cap = captureStdio();
  });
  afterEach(() => {
    cap.restore();
  });

  it("no readline → resolves cleanly with no output", async () => {
    const { ui } = makeUI({
      markdownEnabled: false,
      verboseOutput: false,
      readlineInstance: null,
      // `lastUserInputTime` deliberately omitted — covers the
      // "treated as 0" path for opt-out test sites too.
    });
    await ui.drainPasteBuffer();
    expect(cap.stdout()).toBe("");
  });

  it("within grace window → skips drain, no warning", async () => {
    const fake = new FakeReadline();
    // Stage a partial line that *would* be captured if drain ran.
    fake.line = "stale-paste-tail";
    fake.cursor = fake.line.length;
    const { ui } = makeUI({
      markdownEnabled: false,
      verboseOutput: false,
      readlineInstance: asRl(fake),
      lastUserInputTime: Date.now(), // just-now → within 500ms grace
    });
    await ui.drainPasteBuffer();
    expect(cap.stdout()).toBe("");
    // Buffer must be left intact — drain didn't run.
    expect(fake.line).toBe("stale-paste-tail");
  });

  it("past grace window with empty buffer → quiet resolve", async () => {
    const fake = new FakeReadline();
    const { ui } = makeUI({
      markdownEnabled: false,
      verboseOutput: false,
      readlineInstance: asRl(fake),
      lastUserInputTime: Date.now() - 10_000, // well past grace
    });
    await ui.drainPasteBuffer();
    expect(cap.stdout()).toBe("");
  });

  it("captures partial internal line and warns once", async () => {
    const fake = new FakeReadline();
    fake.line = "leftover from earlier paste";
    fake.cursor = fake.line.length;
    const { ui } = makeUI({
      markdownEnabled: false,
      verboseOutput: false,
      readlineInstance: asRl(fake),
      lastUserInputTime: 0, // ancient → drain runs
    });
    await ui.drainPasteBuffer();
    const out = cap.stdout();
    expect(out).toContain("Discarded 1 buffered line(s) from paste:");
    expect(out).toContain("leftover from earlier paste");
    // Internal buffer cleared.
    expect(fake.line).toBe("");
    expect(fake.cursor).toBe(0);
  });

  it("collects buffered `line` events that flush during the quiet window", async () => {
    const fake = new FakeReadline();
    const { ui } = makeUI({
      markdownEnabled: false,
      verboseOutput: false,
      readlineInstance: asRl(fake),
      lastUserInputTime: 0,
    });

    // Start the drain — it subscribes to `line` events for ~80ms.
    const drainPromise = ui.drainPasteBuffer();
    // Fire two buffered lines on the next macrotask so the
    // subscription is in place.
    setTimeout(() => {
      fake.pushLine("buffered-1");
      fake.pushLine("buffered-2");
    }, 0);
    await drainPromise;

    const out = cap.stdout();
    expect(out).toContain("Discarded 2 buffered line(s) from paste:");
    expect(out).toContain("buffered-1");
    expect(out).toContain("buffered-2");
  });

  it("over preview-count (2) lines → ‘and N more’ tail", async () => {
    const fake = new FakeReadline();
    const { ui } = makeUI({
      markdownEnabled: false,
      verboseOutput: false,
      readlineInstance: asRl(fake),
      lastUserInputTime: 0,
    });
    const drainPromise = ui.drainPasteBuffer();
    setTimeout(() => {
      fake.pushLine("buffered-1");
      fake.pushLine("buffered-2");
      fake.pushLine("buffered-3");
      fake.pushLine("buffered-4");
    }, 0);
    await drainPromise;
    const out = cap.stdout();
    expect(out).toContain("Discarded 4 buffered line(s) from paste:");
    // First two are previewed verbatim.
    expect(out).toContain("buffered-1");
    expect(out).toContain("buffered-2");
    // Remainder summarised, not previewed.
    expect(out).toContain("...and 2 more");
    expect(out).not.toContain("buffered-3");
    expect(out).not.toContain("buffered-4");
  });

  it("ignores empty / whitespace `line` events", async () => {
    const fake = new FakeReadline();
    const { ui } = makeUI({
      markdownEnabled: false,
      verboseOutput: false,
      readlineInstance: asRl(fake),
      lastUserInputTime: 0,
    });
    const drainPromise = ui.drainPasteBuffer();
    setTimeout(() => {
      fake.pushLine("");
      fake.pushLine("   ");
    }, 0);
    await drainPromise;
    expect(cap.stdout()).toBe("");
  });

  it("truncates preview lines longer than DRAIN_PREVIEW_LEN (50)", async () => {
    const fake = new FakeReadline();
    const long = "x".repeat(80);
    fake.line = long;
    fake.cursor = long.length;
    const { ui } = makeUI({
      markdownEnabled: false,
      verboseOutput: false,
      readlineInstance: asRl(fake),
      lastUserInputTime: 0,
    });
    await ui.drainPasteBuffer();
    const out = cap.stdout();
    expect(out).toContain("Discarded 1 buffered line(s) from paste:");
    // 50 chars of 'x' + ellipsis ─ longer strings must NOT appear.
    expect(out).toContain("x".repeat(50) + "...");
    expect(out).not.toContain("x".repeat(60));
  });

  it("live opts swap → second call uses the new readline", async () => {
    const fakeOld = new FakeReadline();
    fakeOld.line = "from-old-paste";
    fakeOld.cursor = fakeOld.line.length;

    const { ui, opts } = makeUI({
      markdownEnabled: false,
      verboseOutput: false,
      readlineInstance: asRl(fakeOld),
      lastUserInputTime: 0,
    });
    await ui.drainPasteBuffer();
    expect(cap.stdout()).toContain("from-old-paste");

    // Mid-session: rl swap (e.g. /new). Stage a fresh fake.
    const fakeNew = new FakeReadline();
    fakeNew.line = "from-new-paste";
    fakeNew.cursor = fakeNew.line.length;
    opts.readlineInstance = asRl(fakeNew);

    await ui.drainPasteBuffer();
    expect(cap.stdout()).toContain("from-new-paste");
    // Old fake is untouched on the second call.
    expect(fakeOld.line).toBe("");
  });
});

describe("NullUI.drainPasteBuffer", () => {
  it("resolves cleanly with no side effects", async () => {
    const ui = new NullUI();
    await expect(ui.drainPasteBuffer()).resolves.toBeUndefined();
  });
});
