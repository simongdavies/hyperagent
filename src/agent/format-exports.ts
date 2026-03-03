// ── agent/format-exports.ts — Export formatting utility ───────────────
//
// Pure display utility for formatting export information.
// No parsing logic — all parsing is done in the Rust guest.
//
// ─────────────────────────────────────────────────────────────────────

/** Parameter information for a function export. */
export interface ParamInfo {
  name: string;
  type?: string;
  description?: string;
  required: boolean;
}

/** Information about a single exported symbol. */
export interface ExportInfo {
  /** Symbol name (e.g. "crc32", "strToBytes"). */
  name: string;
  /** Human-readable signature (e.g. "crc32(data: Uint8Array): number"). */
  signature?: string;
  /** First line of JSDoc or @description, if present. */
  description?: string;
  /** @requires tags - module/plugin dependencies (e.g. ["host:fs-write", "ha:zip-format"]). */
  requires?: string[];
  /** Parameter information with types and descriptions. */
  params?: ParamInfo[];
  /** Return type information. */
  returns?: {
    type?: string;
    description?: string;
  };
}

/**
 * Format ExportInfo array as a compact multi-line string for LLM consumption.
 *
 * Example output:
 *   crc32(data: Uint8Array): number — Calculate CRC32 checksum
 *   deflate(data: Uint8Array): Uint8Array — Compress data
 *   inflate(data: Uint8Array): Uint8Array — Decompress data
 *   PI: number
 *
 * @param exports — Array of export info objects
 * @returns Formatted string, one line per export
 */
export function formatExports(exports: ExportInfo[]): string {
  if (exports.length === 0) return "(no exports found)";
  return exports
    .map((e) => {
      const desc = e.description ? ` — ${e.description}` : "";
      const req = e.requires?.length
        ? ` [requires: ${e.requires.join(", ")}]`
        : "";
      return `${e.signature ?? e.name}${desc}${req}`;
    })
    .join("\n");
}

/**
 * Format exports with full parameter details for API discovery.
 *
 * Example output:
 *   textBox(pres, opts)
 *     pres: Presentation — The presentation object (required)
 *     opts: TextBoxOptions — Text box configuration (required)
 *     returns: Shape — The created text box shape
 *     Description: Create a text box on a slide
 *
 * @param exports — Array of export info objects
 * @returns Formatted string with full parameter details
 */
export function formatSignatures(exports: ExportInfo[]): string {
  if (exports.length === 0) return "(no exports found)";

  return exports
    .map((e) => {
      const lines: string[] = [];

      // Signature line
      lines.push(e.signature ?? e.name);

      // Parameters with types and descriptions
      if (e.params?.length) {
        for (const p of e.params) {
          const typeStr = p.type ? `: ${p.type}` : "";
          const descStr = p.description ? ` — ${p.description}` : "";
          const reqStr = p.required ? "" : " (optional)";
          lines.push(`  ${p.name}${typeStr}${descStr}${reqStr}`);
        }
      }

      // Return type
      if (e.returns?.type) {
        const retDesc = e.returns.description
          ? ` — ${e.returns.description}`
          : "";
        lines.push(`  returns: ${e.returns.type}${retDesc}`);
      }

      // Description (if not already in signature line)
      if (e.description) {
        lines.push(`  Description: ${e.description}`);
      }

      // Requirements
      if (e.requires?.length) {
        lines.push(`  requires: ${e.requires.join(", ")}`);
      }

      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * Format exports as a compact "cheat sheet" - just names and required params.
 *
 * Example output:
 *   textBox(opts)
 *   rect(opts)
 *   titleSlide(pres, opts)
 *   embedImage(pres, opts)
 *   VERSION
 *
 * Optional params shown in brackets:
 *   table(pres, opts, [theme])
 *
 * @param exports — Array of export info objects
 * @returns Compact one-liner per export
 */
export function formatCompact(exports: ExportInfo[]): string {
  if (exports.length === 0) return "(no exports found)";

  return exports
    .map((e) => {
      // If no params, just return the name
      if (!e.params?.length) {
        return e.name;
      }

      // Build param list: required params plain, optional in brackets
      const required = e.params.filter((p) => p.required).map((p) => p.name);
      const optional = e.params.filter((p) => !p.required).map((p) => p.name);

      let paramStr = required.join(", ");
      if (optional.length > 0) {
        const optStr = optional.map((o) => `[${o}]`).join(", ");
        paramStr = paramStr ? `${paramStr}, ${optStr}` : optStr;
      }

      return `${e.name}(${paramStr})`;
    })
    .join("\n");
}
