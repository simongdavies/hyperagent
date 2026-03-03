// @module base64
// @description Base64 encode/decode for Uint8Array
// @created 2026-03-07T00:00:00.000Z
// @modified 2026-03-07T00:00:00.000Z
// @mutable false
// @author system

// Hints are now in base64.json (structured metadata).

const CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Encode a Uint8Array as a Base64 string.
 * @param bytes - Raw bytes to encode
 * @returns Base64-encoded string
 */
export function encode(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i],
      b = bytes[i + 1] ?? 0,
      c = bytes[i + 2] ?? 0;
    const triplet = (a << 16) | (b << 8) | c;
    result += CHARS[(triplet >> 18) & 0x3f] + CHARS[(triplet >> 12) & 0x3f];
    result += i + 1 < bytes.length ? CHARS[(triplet >> 6) & 0x3f] : "=";
    result += i + 2 < bytes.length ? CHARS[triplet & 0x3f] : "=";
  }
  return result;
}

/**
 * Decode a Base64 string to a Uint8Array.
 * @param str - Base64-encoded string
 * @returns Decoded bytes
 */
export function decode(str: string): Uint8Array {
  const lookup = new Uint8Array(128);
  for (let i = 0; i < CHARS.length; i++) lookup[CHARS.charCodeAt(i)] = i;
  const clean = str.replace(/[^A-Za-z0-9+/]/g, "");
  const len = clean.length;
  const bytes = new Uint8Array((len * 3) >> 2);
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const a = lookup[clean.charCodeAt(i)];
    const b = lookup[clean.charCodeAt(i + 1)];
    const c = lookup[clean.charCodeAt(i + 2)];
    const d = lookup[clean.charCodeAt(i + 3)];
    bytes[p++] = (a << 2) | (b >> 4);
    if (i + 2 < len) bytes[p++] = ((b & 0xf) << 4) | (c >> 2);
    if (i + 3 < len) bytes[p++] = ((c & 0x3) << 6) | d;
  }
  return bytes.subarray(0, p);
}
