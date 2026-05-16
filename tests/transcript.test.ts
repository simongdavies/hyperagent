// ── Transcript Tests ─────────────────────────────────────────────────
//
// Tests for the session transcript module: ANSI stripping, header/footer
// building, and Transcript class lifecycle.
//
// ─────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  stripAnsi,
  buildHeader,
  buildFooter,
  Transcript,
  type TranscriptConfig,
} from "../src/agent/transcript.js";

// ── stripAnsi ────────────────────────────────────────────────────────

describe("stripAnsi", () => {
  test("removes colour codes (SGR sequences)", () => {
    const input = "\x1b[32mGreen\x1b[0m and \x1b[1;33mBold Yellow\x1b[0m";
    expect(stripAnsi(input)).toBe("Green and Bold Yellow");
  });

  test("removes cursor movement sequences", () => {
    // CSI cursor up (A), down (B), forward (C), back (D)
    const input = "Hello\x1b[2AWorld\x1b[3B!\x1b[1C?\x1b[4D.";
    expect(stripAnsi(input)).toBe("HelloWorld!?.");
  });

  test("removes erase sequences", () => {
    // Clear line (K), clear screen (J)
    const input = "Line\x1b[K end\x1b[2J cleared";
    expect(stripAnsi(input)).toBe("Line end cleared");
  });

  test("preserves emojis", () => {
    const input = "\x1b[32m🚀 Launch\x1b[0m 🎉 Party 🤖 Robot";
    expect(stripAnsi(input)).toBe("🚀 Launch 🎉 Party 🤖 Robot");
  });

  test("preserves box-drawing characters", () => {
    const input =
      "\x1b[1m╔═══╗\x1b[0m\n\x1b[1m║   ║\x1b[0m\n\x1b[1m╚═══╝\x1b[0m";
    expect(stripAnsi(input)).toBe("╔═══╗\n║   ║\n╚═══╝");
  });

  test("preserves mathematical symbols and accented characters", () => {
    const input = "\x1b[36mπ ≈ 3.14159\x1b[0m, résumé, naïve, √2";
    expect(stripAnsi(input)).toBe("π ≈ 3.14159, résumé, naïve, √2");
  });

  test("handles text with no ANSI codes (passthrough)", () => {
    const input = "Just plain text with 🎸 and ñ";
    expect(stripAnsi(input)).toBe(input);
  });

  test("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  test("strips multiple nested/adjacent codes", () => {
    const input = "\x1b[1m\x1b[4m\x1b[31mBold Underline Red\x1b[0m";
    expect(stripAnsi(input)).toBe("Bold Underline Red");
  });
});

// ── buildHeader ──────────────────────────────────────────────────────

describe("buildHeader", () => {
  test("includes start time", () => {
    const time = new Date("2026-02-25T14:30:00Z");
    const header = buildHeader(time);
    expect(header).toContain("HyperAgent Session Transcript");
    // Time format varies by locale — just check it contains date parts
    expect(header).toContain("2026");
  });

  test("includes separator lines", () => {
    const header = buildHeader(new Date());
    // Should have top and bottom separator bars
    const separators = header.match(/═{50,}/g);
    expect(separators).not.toBeNull();
    expect(separators!.length).toBeGreaterThanOrEqual(2);
  });

  test("includes config when provided", () => {
    const config: TranscriptConfig = {
      model: "gpt-4o",
      cpuTimeoutMs: 2000,
      wallClockTimeoutMs: 5000,
      heapSizeMb: 16,
      inputBufferKb: 64,
      outputBufferKb: 64,
    };
    const header = buildHeader(new Date(), config);
    expect(header).toContain("Model: gpt-4o");
    expect(header).toContain("CPU: 2000ms");
    expect(header).toContain("Wall: 5000ms");
    expect(header).toContain("Heap: 16MB");
    expect(header).toContain("In: 64KB");
    expect(header).toContain("Out: 64KB");
  });

  test("omits config section when not provided", () => {
    const header = buildHeader(new Date());
    expect(header).not.toContain("Model:");
    expect(header).not.toContain("CPU:");
  });

  test("handles partial config (some fields undefined)", () => {
    const config: TranscriptConfig = { model: "gpt-4o" };
    const header = buildHeader(new Date(), config);
    expect(header).toContain("Model: gpt-4o");
    // No CPU/Wall/Heap lines since they're undefined
    expect(header).not.toContain("CPU:");
    expect(header).not.toContain("Heap:");
  });
});

// ── buildFooter ──────────────────────────────────────────────────────

describe("buildFooter", () => {
  test("includes session end time", () => {
    const footer = buildFooter(new Date());
    expect(footer).toContain("Session ended:");
  });

  test("includes duration", () => {
    // Start time 30 seconds ago
    const start = new Date(Date.now() - 30_000);
    const footer = buildFooter(start);
    expect(footer).toContain("Duration:");
    expect(footer).toContain("30s");
  });

  test("formats minutes and seconds for longer sessions", () => {
    // Start time 90 seconds ago
    const start = new Date(Date.now() - 90_000);
    const footer = buildFooter(start);
    expect(footer).toContain("1m 30s");
  });

  test("includes separator lines", () => {
    const footer = buildFooter(new Date());
    const separators = footer.match(/═{50,}/g);
    expect(separators).not.toBeNull();
    expect(separators!.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Transcript class ─────────────────────────────────────────────────

describe("Transcript", () => {
  test("active is false before start", () => {
    const t = new Transcript();
    expect(t.active).toBe(false);
    expect(t.rawPath).toBe("");
    expect(t.cleanPath).toBe("");
  });

  test("start creates file in logs dir and activates", () => {
    const t = new Transcript();
    const logPath = t.start({ model: "test-model" });

    expect(t.active).toBe(true);
    expect(logPath).toContain(path.join(os.homedir(), ".hyperagent", "logs"));
    expect(logPath).toMatch(/hyperagent-.*\.log$/);
    expect(t.rawPath).toBe(logPath);
    expect(t.cleanPath).toBe(logPath.replace(/\.log$/, ".txt"));

    // Clean up — use stopSync since we're in a synchronous test context
    t.stopSync();
    // Clean up files
    safeUnlink(t.rawPath);
    safeUnlink(t.cleanPath);
  });

  test("start is idempotent when already active", () => {
    const t = new Transcript();
    const path1 = t.start();
    const path2 = t.start(); // Should return same path
    expect(path2).toBe(path1);

    t.stopSync();
    safeUnlink(t.rawPath);
    safeUnlink(t.cleanPath);
  });

  test("stop generates both .log and .txt files", async () => {
    const t = new Transcript();
    t.start({ model: "gpt-4o", cpuTimeoutMs: 1000 });

    const { logPath, txtPath } = await t.stop();

    expect(logPath).toMatch(/\.log$/);
    expect(txtPath).toMatch(/\.txt$/);
    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.existsSync(txtPath)).toBe(true);

    // Both files should contain the header
    const logContent = fs.readFileSync(logPath, "utf8");
    const txtContent = fs.readFileSync(txtPath, "utf8");
    expect(logContent).toContain("HyperAgent Session Transcript");
    expect(txtContent).toContain("HyperAgent Session Transcript");

    // Both should contain config
    expect(logContent).toContain("Model: gpt-4o");
    expect(txtContent).toContain("Model: gpt-4o");

    // Both should contain footer
    expect(logContent).toContain("Session ended:");
    expect(txtContent).toContain("Session ended:");

    // Clean up
    safeUnlink(logPath);
    safeUnlink(txtPath);
  });

  test("stopSync generates both files synchronously", () => {
    const t = new Transcript();
    t.start();

    const { logPath, txtPath } = t.stopSync();

    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.existsSync(txtPath)).toBe(true);

    // Clean up
    safeUnlink(logPath);
    safeUnlink(txtPath);
  });

  test("stop on inactive transcript returns empty paths", async () => {
    const t = new Transcript();
    const result = await t.stop();
    expect(result.logPath).toBe("");
    expect(result.txtPath).toBe("");
  });

  test(".txt file has ANSI codes stripped while .log preserves them", async () => {
    const t = new Transcript();
    t.start();

    // Drive content through the public `write` method (the same
    // entry point a `TerminalUI` host would hit via the
    // `TerminalOutputListener` subscription). This replaces an
    // earlier flow that wrote directly to `process.stdout` and
    // relied on a monkey-patch.
    t.write("\x1b[32m🚀 Green rocket\x1b[0m\n");

    const { logPath, txtPath } = await t.stop();

    const logContent = fs.readFileSync(logPath, "utf8");
    const txtContent = fs.readFileSync(txtPath, "utf8");

    // .log should contain ANSI codes
    expect(logContent).toContain("\x1b[32m");
    expect(logContent).toContain("🚀 Green rocket");

    // .txt should have ANSI stripped but emoji preserved
    expect(txtContent).not.toContain("\x1b[32m");
    expect(txtContent).toContain("🚀 Green rocket");

    // Clean up
    safeUnlink(logPath);
    safeUnlink(txtPath);
  });

  test("attachTo: subscribes on start, unsubscribes on stop", async () => {
    const t = new Transcript();

    // Minimal in-memory host that lets us verify subscribe / unsubscribe
    // and feed bytes through the listener.
    const listeners = new Set<{ write(s: string): void }>();
    const host = {
      addOutputListener(listener: { write(s: string): void }): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    t.attachTo(host);
    // No subscription until start (deferred so attach order doesn't matter).
    expect(listeners.size).toBe(0);

    t.start();
    expect(listeners.size).toBe(1);

    // Forward a chunk through the host's listener — the transcript
    // should append it to the raw log.
    for (const l of listeners) l.write("hello from host\n");

    const { logPath, txtPath } = await t.stop();
    expect(listeners.size).toBe(0); // unsubscribed on stop

    const txt = fs.readFileSync(txtPath, "utf8");
    expect(txt).toContain("hello from host");

    safeUnlink(logPath);
    safeUnlink(txtPath);
  });

  test("attachTo: re-attaching a new host swaps the subscription", async () => {
    const t = new Transcript();
    const a = new Set<{ write(s: string): void }>();
    const b = new Set<{ write(s: string): void }>();
    const hostA = {
      addOutputListener(l: { write(s: string): void }): () => void {
        a.add(l);
        return () => a.delete(l);
      },
    };
    const hostB = {
      addOutputListener(l: { write(s: string): void }): () => void {
        b.add(l);
        return () => b.delete(l);
      },
    };

    t.attachTo(hostA);
    t.start();
    expect(a.size).toBe(1);
    expect(b.size).toBe(0);

    // Mid-recording swap. The previous subscription must be released
    // (no double-recording) and the new host must be wired up.
    t.attachTo(hostB);
    expect(a.size).toBe(0);
    expect(b.size).toBe(1);

    for (const l of b) l.write("from B\n");

    const { logPath, txtPath } = await t.stop();
    const txt = fs.readFileSync(txtPath, "utf8");
    expect(txt).toContain("from B");

    safeUnlink(logPath);
    safeUnlink(txtPath);
  });

  test("write: silently dropped when transcript is inactive", () => {
    const t = new Transcript();
    // Should not throw — the listener interface is callable at any time.
    t.write("orphaned\n");
    expect(t.active).toBe(false);
  });

  test("never patches process.stdout.write across start / stop", async () => {
    // The Phase 5 invariant: stdout monkey-patching is gone. The
    // transcript now subscribes to a `TerminalUI` host as a
    // `TerminalOutputListener` instead. We capture the reference
    // outside the transcript lifecycle and assert it never moves.
    const origStdoutWrite = process.stdout.write;

    const t = new Transcript();
    t.start();
    expect(t.active).toBe(true);
    // Critical: stdout reference must be untouched while recording.
    expect(process.stdout.write).toBe(origStdoutWrite);

    await t.stop();
    expect(t.active).toBe(false);
    // And still untouched after stop — defensive check against
    // an accidental late patch slipping in via restore-streams.
    expect(process.stdout.write).toBe(origStdoutWrite);

    // Verify stdout still works (writing doesn't throw).
    const written = process.stdout.write("test\n");
    expect(written).toBe(true);

    // Clean up
    safeUnlink(t.rawPath);
    safeUnlink(t.cleanPath);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────

/** Safely unlink a file, ignoring "not found" errors. */
function safeUnlink(filePath: string): void {
  try {
    if (filePath) fs.unlinkSync(filePath);
  } catch {
    // File may not exist — that's fine
  }
}
