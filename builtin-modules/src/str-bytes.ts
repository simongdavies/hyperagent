// @module str-bytes
// @description String to binary conversion, uint LE encoding, array concatenation - TextEncoder replacement
// @created 2026-03-07T00:00:00.000Z
// @modified 2026-03-07T00:00:00.000Z
// @mutable false
// @author system

/**
 * Convert a string to a Uint8Array (Latin-1 / byte-per-char).
 * Replacement for TextEncoder which is unavailable in QuickJS.
 * Only handles code points 0-255 (Latin-1). For multi-byte Unicode,
 * use strToUtf8Bytes instead.
 * @param s - Input string
 * @returns Byte array
 */
export function strToBytes(s: string): Uint8Array {
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff;
  return a;
}

/**
 * Convert a Uint8Array back to a string (Latin-1 / byte-per-char).
 * Replacement for TextDecoder which is unavailable in QuickJS.
 * @param a - Byte array
 * @returns Decoded string
 */
export function bytesToStr(a: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < a.length; i += 8192) {
    chunks.push(String.fromCharCode(...a.subarray(i, i + 8192)));
  }
  return chunks.join("");
}

/**
 * Encode a string as UTF-8 bytes. Handles multi-byte Unicode correctly.
 * Use this for text that may contain characters outside Latin-1.
 * @param s - Input string (any Unicode)
 * @returns UTF-8 encoded bytes
 */
export function strToUtf8Bytes(s: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const lo = s.charCodeAt(++i);
      c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
      bytes.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      );
    } else {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Convert a 16-bit integer to 2 bytes (little-endian).
 * Common in binary file format construction (ZIP, PPTX, etc.)
 * @param n - 16-bit integer
 * @returns 2-byte array
 */
export function uint16LE(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
}

/**
 * Convert a 32-bit integer to 4 bytes (little-endian).
 * @param n - 32-bit integer
 * @returns 4-byte array
 */
export function uint32LE(n: number): Uint8Array {
  return new Uint8Array([
    n & 0xff,
    (n >> 8) & 0xff,
    (n >> 16) & 0xff,
    (n >> 24) & 0xff,
  ]);
}

/**
 * Concatenate multiple Uint8Arrays into a single array.
 * @param arrays - Arrays to concatenate
 * @returns Combined array
 */
export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}
