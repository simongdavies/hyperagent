// @module crc32
// @description CRC32 checksum (IEEE 802.3) for Uint8Array - used by ZIP, PNG, gzip
// @created 2026-03-07T00:00:00.000Z
// @modified 2026-03-07T00:00:00.000Z
// @mutable false
// @author system

/**
 * Pre-computed CRC32 lookup table (IEEE 802.3 polynomial).
 */
const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE[i] = c;
}

/**
 * Calculate CRC32 checksum for binary data.
 * Uses the IEEE 802.3 polynomial (same as ZIP, PNG, gzip).
 * @param data - Raw bytes to checksum
 * @returns Unsigned 32-bit CRC value
 */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Update a running CRC32 with additional data (streaming).
 * Call with initial=0xFFFFFFFF, finalize by XORing with 0xFFFFFFFF.
 * @param crc - Running CRC value (start with 0xFFFFFFFF)
 * @param data - Additional bytes
 * @returns Updated CRC value (not finalized)
 */
export function crc32Update(crc: number, data: Uint8Array): number {
  for (let i = 0; i < data.length; i++) {
    crc = TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return crc;
}

/**
 * Finalize a running CRC32 value.
 * @param crc - Running CRC from crc32Update
 * @returns Final unsigned 32-bit CRC
 */
export function crc32Finalize(crc: number): number {
  return (crc ^ 0xffffffff) >>> 0;
}
