// ── Command History Persistence Tests ─────────────────────────────────
//
// Tests for the persistent command history feature.
// History is stored at ~/.hyperagent_history and persists between sessions.
//
// Also tests the Ctrl+R reverse search helpers.
//
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";

import { isCtrlR } from "../src/agent/reverse-search.js";

// ── Test Utilities ────────────────────────────────────────────────────
// These mirror the functions in agent.ts but use a test-specific path.

/**
 * Load command history from disk for readline.
 * Returns newest-first (readline's expected format).
 *
 * Multi-line entries are stored with embedded newlines escaped as \x00n.
 * Literal NUL bytes (rare) are stored as \x00\x00.
 * Entries are separated by record separator (ASCII 30).
 */
function loadHistory(historyFile: string): string[] {
  try {
    if (!existsSync(historyFile)) return [];
    let content = readFileSync(historyFile, "utf-8");
    // Remove trailing newline only (not leading whitespace which may be part of entries)
    if (content.endsWith("\n")) {
      content = content.slice(0, -1);
    }
    if (!content) return [];

    // Split by record separator, unescape each entry
    const entries = content.split("\x1e").map((entry) =>
      // Unescape: \x00\x00 -> NUL, \x00n -> newline (order matters)
      entry.replace(/\x00\x00/g, "\x00").replace(/\x00n/g, "\n"),
    );

    // File stores oldest-first (like bash), readline wants newest-first
    return entries.filter(Boolean).reverse();
  } catch {
    return [];
  }
}

/**
 * Save command history to disk.
 * Receives newest-first from readline, writes oldest-first (like bash).
 *
 * Multi-line entries have embedded newlines escaped as \x00n.
 * Literal NUL bytes (rare) are stored as \x00\x00.
 * Entries are separated by record separator (ASCII 30) to distinguish from
 * escaped newlines within entries.
 */
function saveHistory(historyFile: string, history: string[]): void {
  // Escape: NUL -> \x00\x00, newline -> \x00n (order matters - NUL first)
  const escaped = history.map((entry) =>
    entry.replace(/\x00/g, "\x00\x00").replace(/\n/g, "\x00n"),
  );

  // Reverse to oldest-first for file storage, use record separator between entries
  writeFileSync(historyFile, escaped.slice().reverse().join("\x1e") + "\n");
}

// ── Test Suite ────────────────────────────────────────────────────────

describe("command history persistence", () => {
  let testDir: string;
  let historyFile: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `hyperagent-history-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    historyFile = join(testDir, ".hyperagent_history");
  });

  afterEach(() => {
    try {
      if (existsSync(historyFile)) unlinkSync(historyFile);
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("loadHistory", () => {
    it("should return empty array when file does not exist", () => {
      const history = loadHistory(historyFile);
      expect(history).toEqual([]);
    });

    it("should return empty array for empty file", () => {
      writeFileSync(historyFile, "");
      const history = loadHistory(historyFile);
      expect(history).toEqual([]);
    });

    it("should load history in reverse order (newest-first)", () => {
      // File stores oldest-first, separated by record separator
      writeFileSync(historyFile, "first\x1esecond\x1ethird\n");
      const history = loadHistory(historyFile);
      // readline expects newest-first
      expect(history).toEqual(["third", "second", "first"]);
    });

    it("should handle file with trailing newline", () => {
      writeFileSync(historyFile, "cmd1\x1ecmd2\n");
      const history = loadHistory(historyFile);
      expect(history).toEqual(["cmd2", "cmd1"]);
    });

    it("should handle file without trailing newline", () => {
      writeFileSync(historyFile, "cmd1\x1ecmd2");
      const history = loadHistory(historyFile);
      expect(history).toEqual(["cmd2", "cmd1"]);
    });

    it("should filter empty entries", () => {
      writeFileSync(historyFile, "cmd1\x1e\x1ecmd2\x1e\x1e\x1ecmd3\n");
      const history = loadHistory(historyFile);
      expect(history).toEqual(["cmd3", "cmd2", "cmd1"]);
    });

    it("should handle single command", () => {
      writeFileSync(historyFile, "only-one\n");
      const history = loadHistory(historyFile);
      expect(history).toEqual(["only-one"]);
    });

    it("should preserve whitespace within commands", () => {
      writeFileSync(historyFile, "normal command\x1ecommand with spaces\n");
      const history = loadHistory(historyFile);
      expect(history).toEqual(["command with spaces", "normal command"]);
    });

    it("should handle commands with embedded newlines", () => {
      // Newlines are escaped as \x00n - use actual bytes, not escaped string
      writeFileSync(historyFile, "normal command\x1eecho 'hello\x00nworld'\n");
      const history = loadHistory(historyFile);
      expect(history).toEqual(["echo 'hello\nworld'", "normal command"]);
    });

    it("should handle Unicode commands", () => {
      writeFileSync(
        historyFile,
        "/help\x1e你好世界\x1eこんにちは\x1e🚀 emoji\n",
      );
      const history = loadHistory(historyFile);
      expect(history).toEqual(["🚀 emoji", "こんにちは", "你好世界", "/help"]);
    });

    it("should handle very long commands", () => {
      const longCmd = "x".repeat(10000);
      writeFileSync(historyFile, `short\x1e${longCmd}\n`);
      const history = loadHistory(historyFile);
      expect(history).toEqual([longCmd, "short"]);
    });
  });

  describe("saveHistory", () => {
    it("should save history in reverse order (oldest-first)", () => {
      // readline provides newest-first
      saveHistory(historyFile, ["third", "second", "first"]);
      // File stores oldest-first, entries separated by record separator
      const content = readFileSync(historyFile, "utf-8");
      expect(content).toBe("first\x1esecond\x1ethird\n");
    });

    it("should add trailing newline", () => {
      saveHistory(historyFile, ["cmd"]);
      const content = readFileSync(historyFile, "utf-8");
      expect(content.endsWith("\n")).toBe(true);
    });

    it("should handle empty history", () => {
      saveHistory(historyFile, []);
      const content = readFileSync(historyFile, "utf-8");
      expect(content).toBe("\n");
    });

    it("should handle single command", () => {
      saveHistory(historyFile, ["only"]);
      const content = readFileSync(historyFile, "utf-8");
      expect(content).toBe("only\n");
    });

    it("should preserve whitespace in commands", () => {
      saveHistory(historyFile, ["  spaces  "]);
      const content = readFileSync(historyFile, "utf-8");
      expect(content).toBe("  spaces  \n");
    });

    it("should handle Unicode commands", () => {
      saveHistory(historyFile, ["🚀", "日本語"]);
      const content = readFileSync(historyFile, "utf-8");
      expect(content).toBe("日本語\x1e🚀\n");
    });

    it("should overwrite existing file", () => {
      writeFileSync(historyFile, "old1\x1eold2\n");
      saveHistory(historyFile, ["new1", "new2"]);
      const content = readFileSync(historyFile, "utf-8");
      expect(content).toBe("new2\x1enew1\n");
    });

    it("should not mutate input array", () => {
      const input = ["a", "b", "c"];
      const original = [...input];
      saveHistory(historyFile, input);
      expect(input).toEqual(original);
    });

    it("should escape newlines in entries", () => {
      saveHistory(historyFile, ["line1\nline2"]);
      const content = readFileSync(historyFile, "utf-8");
      // Newlines are escaped as \x00n
      expect(content).toBe("line1\x00nline2\n");
    });
  });

  describe("round-trip", () => {
    it("should preserve history through save/load cycle", () => {
      const original = ["newest", "middle", "oldest"];
      saveHistory(historyFile, original);
      const loaded = loadHistory(historyFile);
      expect(loaded).toEqual(original);
    });

    it("should preserve order through multiple cycles", () => {
      const commands = ["cmd1", "cmd2", "cmd3"];

      // Simulate multiple sessions
      saveHistory(historyFile, commands);
      let loaded = loadHistory(historyFile);
      expect(loaded).toEqual(commands);

      // Add more commands (simulate user typing)
      loaded.unshift("cmd4");
      saveHistory(historyFile, loaded);

      loaded = loadHistory(historyFile);
      expect(loaded).toEqual(["cmd4", "cmd1", "cmd2", "cmd3"]);
    });

    it("should handle large history files", () => {
      const largeHistory = Array.from({ length: 1000 }, (_, i) => `cmd-${i}`);
      saveHistory(historyFile, largeHistory);
      const loaded = loadHistory(historyFile);
      expect(loaded).toEqual(largeHistory);
      expect(loaded.length).toBe(1000);
    });

    it("should handle special characters in commands", () => {
      const specialCommands = [
        'echo "hello"',
        "echo 'world'",
        "ls | grep foo",
        "cat file > out",
        "cmd && other",
        "path/to/file",
        "C:\\Windows\\System32",
        "${VAR}",
        "$(cmd)",
        "`backticks`",
      ];
      saveHistory(historyFile, specialCommands);
      const loaded = loadHistory(historyFile);
      expect(loaded).toEqual(specialCommands);
    });
  });

  describe("edge cases", () => {
    it("should handle non-existent parent directory gracefully on load", () => {
      const badPath = join(testDir, "nonexistent", "dir", ".history");
      const history = loadHistory(badPath);
      expect(history).toEqual([]);
    });

    it("should handle read-only scenario gracefully", () => {
      // loadHistory should handle errors silently
      const history = loadHistory("/root/.hyperagent_history");
      expect(history).toEqual([]);
    });

    it("should handle file with whitespace-only entries", () => {
      // Whitespace-only strings are truthy, so preserved
      writeFileSync(historyFile, "   \x1e\t\x1e  \t  \n");
      const history = loadHistory(historyFile);
      expect(history).toEqual(["  \t  ", "\t", "   "]);
    });

    it("should handle entries with CRLF", () => {
      writeFileSync(historyFile, "cmd1\r\x1ecmd2\r\x1ecmd3\r\n");
      const history = loadHistory(historyFile);
      // The \r will be preserved as part of the command
      expect(history.length).toBe(3);
    });
  });

  describe("file format", () => {
    it("should store oldest-first with record separator", () => {
      // When user types: first, second, third (in order)
      // readline gives us: ["third", "second", "first"] (newest-first)
      saveHistory(historyFile, ["third", "second", "first"]);

      // File stores oldest-first, separated by record separator
      const rawContent = readFileSync(historyFile, "utf-8");
      const entries = rawContent.trim().split("\x1e");

      expect(entries[0]).toBe("first"); // Oldest at start
      expect(entries[1]).toBe("second");
      expect(entries[2]).toBe("third"); // Newest at end
    });
  });

  describe("multi-line entries", () => {
    it("should preserve embedded newlines in history entries", () => {
      const multiline = "line 1\nline 2\nline 3";
      saveHistory(historyFile, [multiline, "single line"]);
      const loaded = loadHistory(historyFile);
      expect(loaded).toEqual([multiline, "single line"]);
    });

    it("should handle entries with only newlines", () => {
      const justNewlines = "\n\n\n";
      saveHistory(historyFile, [justNewlines, "normal"]);
      const loaded = loadHistory(historyFile);
      expect(loaded).toEqual([justNewlines, "normal"]);
    });

    it("should handle mixed single and multi-line entries", () => {
      const entries = [
        "single",
        "multi\nline\nentry",
        "another single",
        "two\nlines",
      ];
      saveHistory(historyFile, entries);
      const loaded = loadHistory(historyFile);
      expect(loaded).toEqual(entries);
    });

    it("should handle backslashes in entries", () => {
      const withBackslash = "C:\\Users\\test\\file.txt";
      const withEscapedN = "literal \\n not a newline";
      saveHistory(historyFile, [withBackslash, withEscapedN]);
      const loaded = loadHistory(historyFile);
      expect(loaded).toEqual([withBackslash, withEscapedN]);
    });

    it("should handle complex pasted content", () => {
      const pastedCode = `function foo() {
  console.log("hello");
  return 42;
}`;
      saveHistory(historyFile, [pastedCode, "simple"]);
      const loaded = loadHistory(historyFile);
      expect(loaded).toEqual([pastedCode, "simple"]);
    });

    it("should handle multi-line entry with various whitespace", () => {
      const withWhitespace = "  indented\n\ttabbed\n   spaced  ";
      saveHistory(historyFile, [withWhitespace]);
      const loaded = loadHistory(historyFile);
      expect(loaded).toEqual([withWhitespace]);
    });
  });
});

// ── Reverse Search (Ctrl+R) Tests ─────────────────────────────────────

describe("reverse search", () => {
  describe("isCtrlR", () => {
    it("should return true for Ctrl+R character", () => {
      expect(isCtrlR("\x12")).toBe(true);
    });

    it("should return false for other characters", () => {
      expect(isCtrlR("r")).toBe(false);
      expect(isCtrlR("R")).toBe(false);
      expect(isCtrlR("\x13")).toBe(false); // Ctrl+S
      expect(isCtrlR("\x1b")).toBe(false); // ESC
      expect(isCtrlR("")).toBe(false);
      expect(isCtrlR("\n")).toBe(false);
    });

    it("should return false for Ctrl+R in escape sequence", () => {
      // ESC + [ + R is an ANSI sequence, not Ctrl+R
      expect(isCtrlR("\x1b[R")).toBe(false);
    });
  });

  // Note: The actual reverseSearch() function is interactive and
  // requires stdin/stdout mocking. These would be integration tests.
  // The unit tests above cover the detection logic.
});
