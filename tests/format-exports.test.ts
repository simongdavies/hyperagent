// ── Format Exports Tests ──────────────────────────────────────────────
//
// Tests for the export formatting utility.
// All parsing tests moved to Rust guest (hyperlight-analysis-guest).
//
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import {
  formatExports,
  formatSignatures,
  formatCompact,
} from "../src/agent/format-exports.js";

describe("formatExports", () => {
  it("should format exports as one line per export", () => {
    const exports = [
      {
        name: "add",
        signature: "add(a: number, b: number): number",
        description: "Add two numbers",
      },
      {
        name: "PI",
        signature: "PI: number",
      },
    ];
    const result = formatExports(exports);
    expect(result).toBe(
      "add(a: number, b: number): number — Add two numbers\nPI: number",
    );
  });

  it("should return placeholder for empty exports", () => {
    expect(formatExports([])).toBe("(no exports found)");
  });

  it("should include requires in formatted output", () => {
    const exports = [
      {
        name: "exportToFile",
        signature: "exportToFile(pres, path, fsWrite)",
        description: "Export presentation to file",
        requires: ["host:fs-write"],
      },
    ];
    const result = formatExports(exports);
    expect(result).toBe(
      "exportToFile(pres, path, fsWrite) — Export presentation to file [requires: host:fs-write]",
    );
  });

  it("should format multiple requires", () => {
    const exports = [
      {
        name: "complexOp",
        signature: "complexOp()",
        requires: ["host:fs-write", "host:fetch"],
      },
    ];
    const result = formatExports(exports);
    expect(result).toBe("complexOp() [requires: host:fs-write, host:fetch]");
  });

  it("should use name when signature is missing", () => {
    const exports = [
      {
        name: "someExport",
      },
    ];
    const result = formatExports(exports);
    expect(result).toBe("someExport");
  });
});

describe("formatSignatures", () => {
  it("should format exports with full parameter details", () => {
    const exports = [
      {
        name: "textBox",
        signature: "textBox(pres, opts): Shape",
        description: "Create a text box",
        params: [
          {
            name: "pres",
            type: "Presentation",
            description: "The presentation object",
            required: true,
          },
          {
            name: "opts",
            type: "TextBoxOptions",
            description: "Text box configuration",
            required: true,
          },
        ],
        returns: {
          type: "Shape",
          description: "The created shape",
        },
      },
    ];
    const result = formatSignatures(exports);
    expect(result).toContain("textBox(pres, opts): Shape");
    expect(result).toContain("pres: Presentation — The presentation object");
    expect(result).toContain("opts: TextBoxOptions — Text box configuration");
    expect(result).toContain("returns: Shape — The created shape");
    expect(result).toContain("Description: Create a text box");
  });

  it("should mark optional parameters", () => {
    const exports = [
      {
        name: "greet",
        signature: "greet(name, greeting?): string",
        params: [
          { name: "name", type: "string", required: true },
          { name: "greeting", type: "string", required: false },
        ],
      },
    ];
    const result = formatSignatures(exports);
    expect(result).toContain("name: string");
    expect(result).not.toContain("name: string (optional)");
    expect(result).toContain("greeting: string (optional)");
  });

  it("should include requires section", () => {
    const exports = [
      {
        name: "saveFile",
        signature: "saveFile(path, data)",
        requires: ["host:fs-write"],
      },
    ];
    const result = formatSignatures(exports);
    expect(result).toContain("requires: host:fs-write");
  });

  it("should return placeholder for empty exports", () => {
    expect(formatSignatures([])).toBe("(no exports found)");
  });

  it("should separate multiple exports with blank lines", () => {
    const exports = [
      { name: "foo", signature: "foo()" },
      { name: "bar", signature: "bar()" },
    ];
    const result = formatSignatures(exports);
    expect(result).toContain("foo()\n\nbar()");
  });
});

describe("formatCompact", () => {
  it("should format as one-liner per export", () => {
    const exports = [
      {
        name: "textBox",
        params: [{ name: "opts", required: true }],
      },
      {
        name: "rect",
        params: [{ name: "opts", required: true }],
      },
    ];
    const result = formatCompact(exports);
    expect(result).toBe("textBox(opts)\nrect(opts)");
  });

  it("should show optional params in brackets", () => {
    const exports = [
      {
        name: "table",
        params: [
          { name: "pres", required: true },
          { name: "opts", required: true },
          { name: "theme", required: false },
        ],
      },
    ];
    const result = formatCompact(exports);
    expect(result).toBe("table(pres, opts, [theme])");
  });

  it("should handle exports with no params", () => {
    const exports = [{ name: "VERSION" }, { name: "PI" }];
    const result = formatCompact(exports);
    expect(result).toBe("VERSION\nPI");
  });

  it("should handle all-optional params", () => {
    const exports = [
      {
        name: "configure",
        params: [{ name: "opts", required: false }],
      },
    ];
    const result = formatCompact(exports);
    expect(result).toBe("configure([opts])");
  });

  it("should return placeholder for empty exports", () => {
    expect(formatCompact([])).toBe("(no exports found)");
  });
});
