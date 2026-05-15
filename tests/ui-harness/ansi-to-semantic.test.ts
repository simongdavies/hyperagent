// ── ANSI → Semantic Tag Normaliser Tests ───────────────────────────
//
// Unit tests for the test-only ANSI normaliser used by the UI capture
// harness. These tests are intentionally tight: every assertion locks
// down a single piece of behaviour the golden tests rely on.
//
// If anything below fails, the golden goldens are no longer trustworthy.
// ────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { ansiToSemantic } from "./ansi-to-semantic.js";
import { C, ANSI } from "../../src/agent/ansi.js";

describe("ansiToSemantic — passthrough", () => {
  it("returns plain text unchanged (modulo no-op)", () => {
    expect(ansiToSemantic("hello world")).toBe("hello world");
  });

  it("preserves unicode, emoji and box-drawing characters", () => {
    const input = "🎸 résumé ╔═══╗ π ≈ 3.14";
    expect(ansiToSemantic(input)).toBe(input);
  });

  it("returns empty string for empty input", () => {
    expect(ansiToSemantic("")).toBe("");
  });
});

describe("ansiToSemantic — SGR colours", () => {
  it("translates green/red/yellow/cyan/magenta/blue open codes", () => {
    expect(ansiToSemantic(C.ok("ok"))).toBe("<green>ok</green>");
    expect(ansiToSemantic(C.err("bad"))).toBe("<red>bad</red>");
    expect(ansiToSemantic(C.warn("warn"))).toBe("<yellow>warn</yellow>");
    expect(ansiToSemantic(C.info("info"))).toBe("<cyan>info</cyan>");
    expect(ansiToSemantic(C.tool("🔧 tool"))).toBe(
      "<magenta>🔧 tool</magenta>",
    );
    expect(ansiToSemantic(`${ANSI.blue}b${ANSI.reset}`)).toBe("<blue>b</blue>");
  });

  it("translates bold / dim / italic / underline styles", () => {
    expect(ansiToSemantic(C.label("Title"))).toBe("<bold>Title</bold>");
    expect(ansiToSemantic(C.dim("note"))).toBe("<dim>note</dim>");
    expect(ansiToSemantic(`${ANSI.italic}em${ANSI.reset}`)).toBe(
      "<italic>em</italic>",
    );
    expect(ansiToSemantic(`${ANSI.underline}u${ANSI.reset}`)).toBe(
      "<underline>u</underline>",
    );
  });

  it("handles dim+italic (reasoning text wrapper)", () => {
    // C.reasoning() = `${dim}${italic}TEXT${reset}`
    // After one combined reset, both tags must close.
    expect(ansiToSemantic(C.reasoning("thinking…"))).toBe(
      "<dim><italic>thinking…</italic></dim>",
    );
  });

  it("preserves text content between style markers", () => {
    const input = `prefix ${C.ok("✅ Result:")} ${C.dim("/tmp/foo.txt")} suffix`;
    expect(ansiToSemantic(input)).toBe(
      "prefix <green>✅ Result:</green> <dim>/tmp/foo.txt</dim> suffix",
    );
  });

  it("flags unrecognised SGR codes rather than swallowing them", () => {
    // 7 = inverse video — not in our vocabulary
    expect(ansiToSemantic("\x1b[7mX\x1b[0m")).toBe("<ESC:CSI:7m>X");
  });
});

describe("ansiToSemantic — cursor / line control", () => {
  it("tags carriage returns visibly", () => {
    expect(ansiToSemantic("\rhi")).toBe("<cr>hi");
  });

  it("tags clear-line and clear-line-eol", () => {
    expect(ansiToSemantic("\r\x1b[2K")).toBe("<cr><clear-line>");
    expect(ansiToSemantic("\x1b[K")).toBe("<clear-line-eol>");
  });

  it("tags cursor-up with explicit count", () => {
    // Spinner.stop emits: \r\x1b[2K + \x1b[1A + \r\x1b[2K
    const stop = "\r\x1b[2K\x1b[1A\r\x1b[2K";
    expect(ansiToSemantic(stop)).toBe("<cr><clear-line><up><cr><clear-line>");
    expect(ansiToSemantic("\x1b[3A")).toBe("<up:3>");
    expect(ansiToSemantic("\x1b[2B")).toBe("<down:2>");
  });
});

describe("ansiToSemantic — OSC sequences", () => {
  it("tags window-title set (used by session.title_changed)", () => {
    const input = "\x1b]2;HyperAgent: My Conversation\x07";
    expect(ansiToSemantic(input)).toBe("<title:HyperAgent: My Conversation>");
  });

  it("tags OSC 8 hyperlink open/close pair", () => {
    const input = `${C.link("https://example.com", "click here")}`;
    // C.link wraps in OSC 8 + cyan + underline + reset + close-OSC-8.
    // We only assert the OSC 8 framing — the inner style normalises too.
    const out = ansiToSemantic(input);
    expect(out).toContain("<link:https://example.com>");
    expect(out).toContain("click here");
    expect(out).toContain("</link>");
  });
});

describe("ansiToSemantic — robustness", () => {
  it("surfaces unclosed style tags rather than silently swallowing", () => {
    // No \x1b[0m at the end — the producer forgot to reset.
    expect(ansiToSemantic(`${ANSI.bold}hello`)).toBe(
      "<bold>hello<UNCLOSED:bold>",
    );
  });

  it("preserves a lone ESC byte as a visible tag", () => {
    // Unsupported introducer
    expect(ansiToSemantic("a\x1bZb")).toBe("a<ESC:>Zb");
  });

  it("handles unterminated CSI gracefully", () => {
    expect(ansiToSemantic("\x1b[31")).toBe("<ESC:CSI:31>");
  });
});
