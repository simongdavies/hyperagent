// @module zip-format
// @description ZIP file builder with DEFLATE compression - creates valid ZIP archives for PPTX/DOCX/XLSX/EPUB
// @created 2026-03-07T00:00:00.000Z
// @modified 2026-03-12T00:00:00.000Z
// @mutable false
// @author system

import { crc32 } from "ha:crc32";
import { strToBytes, strToUtf8Bytes } from "ha:str-bytes";
import { deflate } from "ha:ziplib";

/** ZIP file entry */
export interface ZipEntry {
  /** File path within the archive */
  name: string;
  /** File content as bytes or UTF-8 string */
  data: Uint8Array | string;
}

/** ZIP creation options */
export interface ZipOptions {
  /** Enable DEFLATE compression (default: true, false = STORE only) */
  compress?: boolean;
}

interface PreparedEntry {
  nameBytes: Uint8Array;
  data: Uint8Array;
  storedData: Uint8Array;
  checksum: number;
  method: number;
  localHeaderSize: number;
  centralHeaderSize: number;
}

/**
 * Create a ZIP file from an array of entries.
 * Uses DEFLATE compression by default - falls back to STORE
 * when compression doesn't reduce size (e.g. already-compressed images).
 *
 * Memory-efficient implementation: pre-calculates total size and writes
 * directly to a single buffer to avoid intermediate allocations.
 *
 * Duplicate file names are automatically deduplicated - last entry wins.
 * This prevents invalid ZIPs when the same file path appears multiple times.
 *
 * @param entries - Files to include
 * @param opts - Options
 * @returns Complete ZIP file as bytes
 */
export function createZip(entries: ZipEntry[], opts?: ZipOptions): Uint8Array {
  const doCompress = opts?.compress !== false;

  // Deduplicate entries by name - last entry wins
  const seenNames = new Map<string, number>();
  const dedupedEntries: ZipEntry[] = [];
  for (const entry of entries) {
    const existing = seenNames.get(entry.name);
    if (existing !== undefined) {
      // Replace earlier entry with this one
      dedupedEntries[existing] = entry;
    } else {
      seenNames.set(entry.name, dedupedEntries.length);
      dedupedEntries.push(entry);
    }
  }

  // First pass: calculate sizes and prepare metadata
  const prepared: PreparedEntry[] = [];
  let totalLocalSize = 0;
  let totalCentralSize = 0;

  for (const entry of dedupedEntries) {
    // Skip null/undefined entries that may result from deduplication array replacement
    if (!entry) continue;

    const nameBytes = strToBytes(entry.name);
    const data =
      typeof entry.data === "string" ? strToUtf8Bytes(entry.data) : entry.data;
    const checksum = crc32(data);

    // Try DEFLATE - use it only if it actually shrinks the data
    let storedData = data;
    let method = 0; // STORE
    if (doCompress && data.length > 0) {
      const compressed = deflate(data);
      if (compressed.length < data.length) {
        storedData = compressed;
        method = 8; // DEFLATE
      }
    }

    const localHeaderSize = 30 + nameBytes.length + storedData.length;
    const centralHeaderSize = 46 + nameBytes.length;

    prepared.push({
      nameBytes,
      data,
      storedData,
      checksum,
      method,
      localHeaderSize,
      centralHeaderSize,
    });

    totalLocalSize += localHeaderSize;
    totalCentralSize += centralHeaderSize;
  }

  // Calculate total ZIP size
  const eocdSize = 22; // End of central directory is fixed 22 bytes
  const totalSize = totalLocalSize + totalCentralSize + eocdSize;

  // Allocate single buffer for entire ZIP
  const result = new Uint8Array(totalSize);
  let pos = 0;
  let localOffset = 0;
  const centralOffsets: number[] = [];

  // Second pass: write local file headers + data
  for (const entry of prepared) {
    centralOffsets.push(localOffset);

    // Local file header (30 bytes + name + data)
    // Signature
    result[pos++] = 0x50;
    result[pos++] = 0x4b;
    result[pos++] = 0x03;
    result[pos++] = 0x04;
    // Version needed (2.0)
    result[pos++] = 20;
    result[pos++] = 0;
    // General purpose bit flag
    result[pos++] = 0;
    result[pos++] = 0;
    // Compression method
    result[pos++] = entry.method;
    result[pos++] = 0;
    // Last mod time/date (zeros)
    result[pos++] = 0;
    result[pos++] = 0;
    result[pos++] = 0;
    result[pos++] = 0;
    // CRC-32
    result[pos++] = entry.checksum & 0xff;
    result[pos++] = (entry.checksum >> 8) & 0xff;
    result[pos++] = (entry.checksum >> 16) & 0xff;
    result[pos++] = (entry.checksum >> 24) & 0xff;
    // Compressed size
    const compSize = entry.storedData.length;
    result[pos++] = compSize & 0xff;
    result[pos++] = (compSize >> 8) & 0xff;
    result[pos++] = (compSize >> 16) & 0xff;
    result[pos++] = (compSize >> 24) & 0xff;
    // Uncompressed size
    const uncompSize = entry.data.length;
    result[pos++] = uncompSize & 0xff;
    result[pos++] = (uncompSize >> 8) & 0xff;
    result[pos++] = (uncompSize >> 16) & 0xff;
    result[pos++] = (uncompSize >> 24) & 0xff;
    // File name length
    result[pos++] = entry.nameBytes.length & 0xff;
    result[pos++] = (entry.nameBytes.length >> 8) & 0xff;
    // Extra field length
    result[pos++] = 0;
    result[pos++] = 0;
    // File name
    result.set(entry.nameBytes, pos);
    pos += entry.nameBytes.length;
    // File data
    result.set(entry.storedData, pos);
    pos += entry.storedData.length;

    localOffset += entry.localHeaderSize;
  }

  // Write central directory
  const centralDirStart = pos;
  for (let i = 0; i < prepared.length; i++) {
    const entry = prepared[i];
    const offset = centralOffsets[i];

    // Central directory file header (46 bytes + name)
    // Signature
    result[pos++] = 0x50;
    result[pos++] = 0x4b;
    result[pos++] = 0x01;
    result[pos++] = 0x02;
    // Version made by (2.0)
    result[pos++] = 20;
    result[pos++] = 0;
    // Version needed (2.0)
    result[pos++] = 20;
    result[pos++] = 0;
    // General purpose bit flag
    result[pos++] = 0;
    result[pos++] = 0;
    // Compression method
    result[pos++] = entry.method;
    result[pos++] = 0;
    // Last mod time/date (zeros)
    result[pos++] = 0;
    result[pos++] = 0;
    result[pos++] = 0;
    result[pos++] = 0;
    // CRC-32
    result[pos++] = entry.checksum & 0xff;
    result[pos++] = (entry.checksum >> 8) & 0xff;
    result[pos++] = (entry.checksum >> 16) & 0xff;
    result[pos++] = (entry.checksum >> 24) & 0xff;
    // Compressed size
    const compSize = entry.storedData.length;
    result[pos++] = compSize & 0xff;
    result[pos++] = (compSize >> 8) & 0xff;
    result[pos++] = (compSize >> 16) & 0xff;
    result[pos++] = (compSize >> 24) & 0xff;
    // Uncompressed size
    const uncompSize = entry.data.length;
    result[pos++] = uncompSize & 0xff;
    result[pos++] = (uncompSize >> 8) & 0xff;
    result[pos++] = (uncompSize >> 16) & 0xff;
    result[pos++] = (uncompSize >> 24) & 0xff;
    // File name length
    result[pos++] = entry.nameBytes.length & 0xff;
    result[pos++] = (entry.nameBytes.length >> 8) & 0xff;
    // Extra field length
    result[pos++] = 0;
    result[pos++] = 0;
    // File comment length
    result[pos++] = 0;
    result[pos++] = 0;
    // Disk number start
    result[pos++] = 0;
    result[pos++] = 0;
    // Internal file attributes
    result[pos++] = 0;
    result[pos++] = 0;
    // External file attributes
    result[pos++] = 0;
    result[pos++] = 0;
    result[pos++] = 0;
    result[pos++] = 0;
    // Relative offset of local header
    result[pos++] = offset & 0xff;
    result[pos++] = (offset >> 8) & 0xff;
    result[pos++] = (offset >> 16) & 0xff;
    result[pos++] = (offset >> 24) & 0xff;
    // File name
    result.set(entry.nameBytes, pos);
    pos += entry.nameBytes.length;
  }

  // Write end of central directory record (22 bytes)
  const centralDirSize = pos - centralDirStart;
  // Signature
  result[pos++] = 0x50;
  result[pos++] = 0x4b;
  result[pos++] = 0x05;
  result[pos++] = 0x06;
  // Number of this disk
  result[pos++] = 0;
  result[pos++] = 0;
  // Disk where central directory starts
  result[pos++] = 0;
  result[pos++] = 0;
  // Number of central directory records on this disk
  result[pos++] = prepared.length & 0xff;
  result[pos++] = (prepared.length >> 8) & 0xff;
  // Total number of central directory records
  result[pos++] = prepared.length & 0xff;
  result[pos++] = (prepared.length >> 8) & 0xff;
  // Size of central directory
  result[pos++] = centralDirSize & 0xff;
  result[pos++] = (centralDirSize >> 8) & 0xff;
  result[pos++] = (centralDirSize >> 16) & 0xff;
  result[pos++] = (centralDirSize >> 24) & 0xff;
  // Offset of start of central directory
  result[pos++] = centralDirStart & 0xff;
  result[pos++] = (centralDirStart >> 8) & 0xff;
  result[pos++] = (centralDirStart >> 16) & 0xff;
  result[pos++] = (centralDirStart >> 24) & 0xff;
  // Comment length
  result[pos++] = 0;
  result[pos++] = 0;

  return result;
}
