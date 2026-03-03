// ── Builtin Module Tests ─────────────────────────────────────────────
//
// Standalone unit tests for the builtin system modules.
// These test the pure JS functions directly — no sandbox needed.
// zip-format is tested via the sandbox since it imports ha:crc32/ha:str-bytes.
//
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";

// ── str-bytes ────────────────────────────────────────────────────────
// Import functions directly — they're plain ES module exports.

const strBytes = await import("../builtin-modules/str-bytes.js");

describe("str-bytes", () => {
  describe("strToBytes", () => {
    it("should convert ASCII string to Uint8Array", () => {
      const result = strBytes.strToBytes("hello");
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(5);
      expect(result[0]).toBe(104); // 'h'
      expect(result[4]).toBe(111); // 'o'
    });

    it("should handle empty string", () => {
      const result = strBytes.strToBytes("");
      expect(result.length).toBe(0);
    });

    it("should mask to 0xFF for Latin-1", () => {
      const result = strBytes.strToBytes("\u00FF"); // ÿ
      expect(result[0]).toBe(0xff);
    });

    it("should truncate code points > 255", () => {
      const result = strBytes.strToBytes("\u0100"); // Ā (256)
      expect(result[0]).toBe(0); // 256 & 0xFF = 0
    });
  });

  describe("bytesToStr", () => {
    it("should convert Uint8Array back to string", () => {
      const bytes = new Uint8Array([104, 101, 108, 108, 111]);
      expect(strBytes.bytesToStr(bytes)).toBe("hello");
    });

    it("should handle empty array", () => {
      expect(strBytes.bytesToStr(new Uint8Array(0))).toBe("");
    });

    it("should handle large arrays (>8192 bytes) via chunking", () => {
      const big = new Uint8Array(10000).fill(65); // 10000 'A's
      const result = strBytes.bytesToStr(big);
      expect(result.length).toBe(10000);
      expect(result[0]).toBe("A");
      expect(result[9999]).toBe("A");
    });
  });

  describe("strToBytes/bytesToStr roundtrip", () => {
    it("should roundtrip ASCII", () => {
      const original = "Hello, World! 123";
      expect(strBytes.bytesToStr(strBytes.strToBytes(original))).toBe(original);
    });

    it("should roundtrip Latin-1 characters", () => {
      const original = "café résumé naïve";
      expect(strBytes.bytesToStr(strBytes.strToBytes(original))).toBe(original);
    });
  });

  describe("strToUtf8Bytes", () => {
    it("should encode ASCII as single bytes", () => {
      const result = strBytes.strToUtf8Bytes("ABC");
      expect(result).toEqual(new Uint8Array([65, 66, 67]));
    });

    it("should encode 2-byte UTF-8 characters", () => {
      // é = U+00E9 → C3 A9
      const result = strBytes.strToUtf8Bytes("é");
      expect(result).toEqual(new Uint8Array([0xc3, 0xa9]));
    });

    it("should encode 3-byte UTF-8 characters", () => {
      // € = U+20AC → E2 82 AC
      const result = strBytes.strToUtf8Bytes("€");
      expect(result).toEqual(new Uint8Array([0xe2, 0x82, 0xac]));
    });

    it("should encode 4-byte UTF-8 characters (surrogate pairs)", () => {
      // 😀 = U+1F600 → F0 9F 98 80
      const result = strBytes.strToUtf8Bytes("😀");
      expect(result).toEqual(new Uint8Array([0xf0, 0x9f, 0x98, 0x80]));
    });

    it("should handle empty string", () => {
      expect(strBytes.strToUtf8Bytes("").length).toBe(0);
    });

    it("should match Node TextEncoder output", () => {
      const input = "Hello, 世界! 🎸";
      const expected = new TextEncoder().encode(input);
      const result = strBytes.strToUtf8Bytes(input);
      expect(result).toEqual(expected);
    });
  });

  describe("uint16LE", () => {
    it("should encode 0 as two zero bytes", () => {
      expect(strBytes.uint16LE(0)).toEqual(new Uint8Array([0, 0]));
    });

    it("should encode 256 as [0, 1] (little-endian)", () => {
      expect(strBytes.uint16LE(256)).toEqual(new Uint8Array([0, 1]));
    });

    it("should encode 0xFFFF", () => {
      expect(strBytes.uint16LE(0xffff)).toEqual(new Uint8Array([0xff, 0xff]));
    });

    it("should encode ZIP signature part (0x4B50)", () => {
      expect(strBytes.uint16LE(0x4b50)).toEqual(new Uint8Array([0x50, 0x4b]));
    });
  });

  describe("uint32LE", () => {
    it("should encode 0 as four zero bytes", () => {
      expect(strBytes.uint32LE(0)).toEqual(new Uint8Array([0, 0, 0, 0]));
    });

    it("should encode ZIP local header signature", () => {
      // 0x04034B50 → [0x50, 0x4B, 0x03, 0x04]
      expect(strBytes.uint32LE(0x04034b50)).toEqual(
        new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      );
    });

    it("should encode 0xFFFFFFFF", () => {
      expect(strBytes.uint32LE(0xffffffff)).toEqual(
        new Uint8Array([0xff, 0xff, 0xff, 0xff]),
      );
    });
  });

  describe("concatBytes", () => {
    it("should concatenate two arrays", () => {
      const a = new Uint8Array([1, 2]);
      const b = new Uint8Array([3, 4]);
      expect(strBytes.concatBytes(a, b)).toEqual(new Uint8Array([1, 2, 3, 4]));
    });

    it("should handle empty arrays", () => {
      const a = new Uint8Array([1, 2]);
      const empty = new Uint8Array(0);
      expect(strBytes.concatBytes(a, empty)).toEqual(new Uint8Array([1, 2]));
      expect(strBytes.concatBytes(empty, a)).toEqual(new Uint8Array([1, 2]));
    });

    it("should concatenate multiple arrays", () => {
      const result = strBytes.concatBytes(
        new Uint8Array([1]),
        new Uint8Array([2, 3]),
        new Uint8Array([4, 5, 6]),
      );
      expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    });

    it("should handle single array", () => {
      const a = new Uint8Array([1, 2, 3]);
      expect(strBytes.concatBytes(a)).toEqual(a);
    });
  });
});

// ── crc32 ────────────────────────────────────────────────────────────

const crc32Mod = await import("../builtin-modules/crc32.js");

describe("crc32", () => {
  it("should compute correct CRC32 for empty data", () => {
    expect(crc32Mod.crc32(new Uint8Array(0))).toBe(0x00000000);
  });

  it("should compute correct CRC32 for 'hello'", () => {
    const data = new TextEncoder().encode("hello");
    // Known CRC32 for "hello" = 0x3610A686
    expect(crc32Mod.crc32(data)).toBe(0x3610a686);
  });

  it("should compute correct CRC32 for '123456789'", () => {
    const data = new TextEncoder().encode("123456789");
    // Known IEEE 802.3 CRC32 check value = 0xCBF43926
    expect(crc32Mod.crc32(data)).toBe(0xcbf43926);
  });

  it("should return unsigned 32-bit value", () => {
    const data = new TextEncoder().encode("test");
    const result = crc32Mod.crc32(data);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(0xffffffff);
  });

  describe("streaming API", () => {
    it("should produce same result as one-shot", () => {
      const data = new TextEncoder().encode("Hello, World!");
      const oneShot = crc32Mod.crc32(data);

      // Stream in two parts
      const part1 = data.slice(0, 5);
      const part2 = data.slice(5);
      let crc = crc32Mod.crc32Update(0xffffffff, part1);
      crc = crc32Mod.crc32Update(crc, part2);
      const streamed = crc32Mod.crc32Finalize(crc);

      expect(streamed).toBe(oneShot);
    });

    it("should handle single-byte streaming", () => {
      const data = new TextEncoder().encode("abc");
      const oneShot = crc32Mod.crc32(data);

      let crc = 0xffffffff;
      for (const byte of data) {
        crc = crc32Mod.crc32Update(crc, new Uint8Array([byte]));
      }
      expect(crc32Mod.crc32Finalize(crc)).toBe(oneShot);
    });
  });
});

// ── base64 ───────────────────────────────────────────────────────────

const base64Mod = await import("../builtin-modules/base64.js");

describe("base64", () => {
  describe("encode", () => {
    it("should encode empty array", () => {
      expect(base64Mod.encode(new Uint8Array(0))).toBe("");
    });

    it("should encode 'hello'", () => {
      const data = new TextEncoder().encode("hello");
      expect(base64Mod.encode(data)).toBe("aGVsbG8=");
    });

    it("should encode single byte", () => {
      expect(base64Mod.encode(new Uint8Array([0]))).toBe("AA==");
    });

    it("should encode two bytes", () => {
      expect(base64Mod.encode(new Uint8Array([0, 1]))).toBe("AAE=");
    });

    it("should encode three bytes (no padding)", () => {
      expect(base64Mod.encode(new Uint8Array([0, 1, 2]))).toBe("AAEC");
    });

    it("should match Node Buffer output", () => {
      const data = new TextEncoder().encode("Hello, World! 🎸");
      const expected = Buffer.from(data).toString("base64");
      expect(base64Mod.encode(data)).toBe(expected);
    });
  });

  describe("decode", () => {
    it("should decode empty string", () => {
      expect(base64Mod.decode("").length).toBe(0);
    });

    it("should decode 'aGVsbG8='", () => {
      const result = base64Mod.decode("aGVsbG8=");
      expect(new TextDecoder().decode(result)).toBe("hello");
    });

    it("should handle missing padding", () => {
      const result = base64Mod.decode("aGVsbG8");
      expect(new TextDecoder().decode(result)).toBe("hello");
    });
  });

  describe("roundtrip", () => {
    it("should roundtrip binary data", () => {
      const original = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
      const encoded = base64Mod.encode(original);
      const decoded = base64Mod.decode(encoded);
      expect(decoded).toEqual(original);
    });

    it("should roundtrip all byte values", () => {
      const all = new Uint8Array(256);
      for (let i = 0; i < 256; i++) all[i] = i;
      expect(base64Mod.decode(base64Mod.encode(all))).toEqual(all);
    });
  });
});

// ── xml-escape ───────────────────────────────────────────────────────

const xmlMod = await import("../builtin-modules/xml-escape.js");

describe("xml-escape", () => {
  describe("escapeXml", () => {
    it("should pass through safe string", () => {
      expect(xmlMod.escapeXml("hello world")).toBe("hello world");
    });

    it("should escape &", () => {
      expect(xmlMod.escapeXml("A & B")).toBe("A &amp; B");
    });

    it("should escape <", () => {
      expect(xmlMod.escapeXml("a < b")).toBe("a &lt; b");
    });

    it("should escape >", () => {
      expect(xmlMod.escapeXml("a > b")).toBe("a &gt; b");
    });

    it("should escape all three in one string", () => {
      expect(xmlMod.escapeXml("<a & b>")).toBe("&lt;a &amp; b&gt;");
    });

    it("should NOT escape quotes (text content only)", () => {
      expect(xmlMod.escapeXml('"quoted"')).toBe('"quoted"');
    });
  });

  describe("escapeAttr", () => {
    it("should escape all five characters", () => {
      expect(xmlMod.escapeAttr(`<a & "b" 'c'>`)).toBe(
        "&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;",
      );
    });
  });

  describe("el", () => {
    it("should create element with text content", () => {
      expect(xmlMod.el("p", "hello")).toBe("<p>hello</p>");
    });

    it("should escape text content automatically", () => {
      expect(xmlMod.el("p", "a & b")).toBe("<p>a &amp; b</p>");
    });

    it("should create self-closing element when content is null", () => {
      expect(xmlMod.el("br", null)).toBe("<br/>");
    });

    it("should create self-closing element when content is undefined", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(xmlMod.el("br", undefined as any)).toBe("<br/>");
    });

    it("should include attributes", () => {
      expect(xmlMod.el("a", "link", { href: "http://example.com" })).toBe(
        '<a href="http://example.com">link</a>',
      );
    });

    it("should escape attribute values", () => {
      expect(xmlMod.el("div", null, { title: 'say "hi"' })).toBe(
        '<div title="say &quot;hi&quot;"/>',
      );
    });

    it("should handle multiple attributes", () => {
      const result = xmlMod.el("rect", null, { x: "0", y: "10", fill: "red" });
      expect(result).toContain('x="0"');
      expect(result).toContain('y="10"');
      expect(result).toContain('fill="red"');
    });
  });
});

// ── ziplib (deflate/inflate) ─────────────────────────────────────────
// The native Rust module (ha:ziplib) runs inside the sandbox.
// For Node.js tests we use the ziplib.shim.js which wraps Node's zlib.
// These tests verify the shim and ensure zip-format can use it.

import { inflateRawSync } from "node:zlib";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const zlibMod: any = await import("./shims/ziplib.shim.js");

describe("ziplib", () => {
  it("should compress and decompress empty input", () => {
    const compressed = zlibMod.deflate(new Uint8Array(0));
    expect(compressed.length).toBe(0);
  });

  it("should compress and decompress a single byte", () => {
    const input = new Uint8Array([42]);
    const compressed = zlibMod.deflate(input);
    const result = inflateRawSync(Buffer.from(compressed));
    expect(new Uint8Array(result)).toEqual(input);
  });

  it("should roundtrip via inflate", () => {
    const input = new Uint8Array([65, 66, 67]);
    const compressed = zlibMod.deflate(input);
    const decompressed = zlibMod.inflate(compressed);
    expect(new Uint8Array(decompressed)).toEqual(input);
  });

  it("should compress repeated bytes with good ratio", () => {
    const input = new Uint8Array(1000).fill(65);
    const compressed = zlibMod.deflate(input);
    const result = inflateRawSync(Buffer.from(compressed));
    expect(new Uint8Array(result)).toEqual(input);
    expect(compressed.length).toBeLessThan(50);
  });

  it("should compress XML content with good ratio", () => {
    const xml = '<root><child attr="value">text</child></root>';
    const input = new TextEncoder().encode(xml.repeat(20));
    const compressed = zlibMod.deflate(input);
    const result = inflateRawSync(Buffer.from(compressed));
    expect(new Uint8Array(result)).toEqual(input);
    expect(compressed.length).toBeLessThan(input.length / 2);
  });

  it("should handle OOXML namespace-heavy content", () => {
    const ooxml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
      '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/>' +
      "<p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr></p:spTree></p:cSld></p:sld>";
    const input = new TextEncoder().encode(ooxml);
    const compressed = zlibMod.deflate(input);
    const result = inflateRawSync(Buffer.from(compressed));
    expect(new Uint8Array(result)).toEqual(input);
    expect(compressed.length).toBeLessThan(input.length);
  });

  it("should handle random data without corruption", () => {
    const input = new Uint8Array(500);
    for (let i = 0; i < 500; i++) input[i] = (i * 7 + 13) & 0xff;
    const compressed = zlibMod.deflate(input);
    const result = inflateRawSync(Buffer.from(compressed));
    expect(new Uint8Array(result)).toEqual(input);
  });

  it("should handle all 256 byte values", () => {
    const input = new Uint8Array(256);
    for (let i = 0; i < 256; i++) input[i] = i;
    const compressed = zlibMod.deflate(input);
    const result = inflateRawSync(Buffer.from(compressed));
    expect(new Uint8Array(result)).toEqual(input);
  });

  it("should handle run-length style patterns", () => {
    const input = new Uint8Array(300);
    for (let i = 0; i < 300; i++) input[i] = 65 + Math.floor((i % 9) / 3);
    const compressed = zlibMod.deflate(input);
    const result = inflateRawSync(Buffer.from(compressed));
    expect(new Uint8Array(result)).toEqual(input);
    expect(compressed.length).toBeLessThan(input.length / 3);
  });

  it("should handle data with long matches (up to 258 bytes)", () => {
    const pattern = new Uint8Array(50);
    for (let i = 0; i < 50; i++) pattern[i] = (i * 17 + 3) & 0xff;
    const input = new Uint8Array(300);
    for (let i = 0; i < 300; i++) input[i] = pattern[i % 50];
    const compressed = zlibMod.deflate(input);
    const result = inflateRawSync(Buffer.from(compressed));
    expect(new Uint8Array(result)).toEqual(input);
    expect(compressed.length).toBeLessThan(input.length / 2);
  });
});

// ── pptx image dimensions ─────────────────────────────────────────────

const pptxMod = await import("../builtin-modules/pptx.js");

describe("getImageDimensions", () => {
  it("should read PNG dimensions from header", () => {
    // Minimal valid PNG header: signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4)
    const png = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a, // PNG signature
      0x00,
      0x00,
      0x00,
      0x0d, // IHDR length (13)
      0x49,
      0x48,
      0x44,
      0x52, // "IHDR"
      0x00,
      0x00,
      0x03,
      0x20, // width = 800 (big endian)
      0x00,
      0x00,
      0x02,
      0x58, // height = 600 (big endian)
      0x08,
      0x06,
      0x00,
      0x00,
      0x00, // bit depth, color type, etc.
    ]);
    const dims = pptxMod.getImageDimensions(png, "png");
    expect(dims).toEqual({ width: 800, height: 600 });
  });

  it("should read GIF dimensions from header", () => {
    // GIF89a header with 640x480
    const gif = new Uint8Array([
      0x47,
      0x49,
      0x46,
      0x38,
      0x39,
      0x61, // "GIF89a"
      0x80,
      0x02, // width = 640 (little endian)
      0xe0,
      0x01, // height = 480 (little endian)
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00, // padding
    ]);
    const dims = pptxMod.getImageDimensions(gif, "gif");
    expect(dims).toEqual({ width: 640, height: 480 });
  });

  it("should read BMP dimensions from header", () => {
    // BMP header with 1024x768
    const bmp = new Uint8Array(30);
    bmp[0] = 0x42; // 'B'
    bmp[1] = 0x4d; // 'M'
    // Width at offset 18 (little endian 32-bit)
    bmp[18] = 0x00;
    bmp[19] = 0x04; // 1024 = 0x0400
    bmp[20] = 0x00;
    bmp[21] = 0x00;
    // Height at offset 22 (little endian 32-bit)
    bmp[22] = 0x00;
    bmp[23] = 0x03; // 768 = 0x0300
    bmp[24] = 0x00;
    bmp[25] = 0x00;
    const dims = pptxMod.getImageDimensions(bmp, "bmp");
    expect(dims).toEqual({ width: 1024, height: 768 });
  });

  it("should return null for invalid PNG signature", () => {
    const notPng = new Uint8Array(30).fill(0);
    const dims = pptxMod.getImageDimensions(notPng, "png");
    expect(dims).toBeNull();
  });

  it("should return null for too-short data", () => {
    const short = new Uint8Array(10);
    const dims = pptxMod.getImageDimensions(short, "png");
    expect(dims).toBeNull();
  });

  it("should return null for SVG (no pixel dimensions)", () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    );
    const dims = pptxMod.getImageDimensions(svg, "svg");
    expect(dims).toBeNull();
  });
});
