// ── tests/buffer-overflow.test.ts ────────────────────────────────────
//
// `buildBufferOverflowHint` is the sole entry point for surfacing the
// Hyperlight "not enough space in buffer" error to the user. Phase 2.5
// promoted it (the legacy `suggestBufferIncreaseIfNeeded` console.log
// helper was removed); these tests guard the parse + suggested-size
// arithmetic + multi-line shape that the UI relies on.

import { describe, expect, it } from "vitest";
import { buildBufferOverflowHint } from "../src/agent/buffer-overflow.js";

describe("buildBufferOverflowHint", () => {
  it("returns null for unrelated error messages", () => {
    expect(buildBufferOverflowHint("Random unrelated failure")).toBeNull();
    expect(buildBufferOverflowHint("")).toBeNull();
  });

  it("matches the Hyperlight pattern case-insensitively", () => {
    const lower =
      "not enough space in buffer to push data. required: 4096, available: 1024";
    const upper =
      "NOT ENOUGH SPACE IN BUFFER to push data. Required: 4096, Available: 1024";
    expect(buildBufferOverflowHint(lower)).not.toBeNull();
    expect(buildBufferOverflowHint(upper)).not.toBeNull();
  });

  it("suggests a buffer size with ~25% headroom, rounded up to whole KB", () => {
    // 4096 bytes * 1.25 = 5120 bytes = 5 KB exactly.
    const exact = buildBufferOverflowHint(
      "Not enough space in buffer to push data. Required: 4096, Available: 1024",
    );
    expect(exact).toContain("/buffer output 5");
    expect(exact).toContain("/buffer input 5");

    // 5000 bytes * 1.25 = 6250 bytes ≈ 6.1 KB → ceil → 7 KB.
    const rounded = buildBufferOverflowHint(
      "Not enough space in buffer. Required: 5000",
    );
    expect(rounded).toContain("/buffer output 7");
    expect(rounded).toContain("/buffer input 7");
  });

  it("returns a four-line hint that the UI can print verbatim", () => {
    const hint = buildBufferOverflowHint(
      "Not enough space in buffer. Required: 8192",
    );
    expect(hint).not.toBeNull();
    // Split on physical newlines — the leading line uses `\n`
    // separators so consumers can write it as one block.
    const lines = hint!.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("💡");
    expect(lines[0]).toContain("exceeded the sandbox buffer size");
    expect(lines[1]).toContain("Try increasing the buffer");
    expect(lines[2]).toContain("/buffer output");
    expect(lines[2]).toContain("if result data is too large");
    expect(lines[3]).toContain("/buffer input");
    expect(lines[3]).toContain("if code being sent is too large");
  });
});
