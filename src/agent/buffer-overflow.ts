// ── Buffer Overflow Detection ────────────────────────────────────────
//
// When the Hyperlight sandbox output (or input) buffer is too small for
// the data being pushed, the runtime emits:
//   "Not enough space in buffer to push data. Required: N, Available: M"
// This helper detects that pattern and prints a user-actionable hint
// with the specific /buffer command needed to resolve it.
//
// ─────────────────────────────────────────────────────────────────────

import { C } from "./ansi.js";

/** Pattern matching Hyperlight buffer-overflow errors, capturing Required bytes. */
const BUFFER_OVERFLOW_RE = /Not enough space in buffer.*Required:\s*(\d+)/i;

/** Bytes → KB multiplier with 25% headroom, then round up to whole KB. */
function suggestedKbForBytes(requiredBytes: number): number {
  return Math.ceil((requiredBytes * 1.25) / 1024);
}

/**
 * If `msg` matches the Hyperlight buffer overflow error pattern,
 * return a formatted multi-line hint suitable for direct console
 * output. Returns `null` when the message does not match.
 *
 * Prefer this function in code that routes through the UI port —
 * pass the returned string as the `hint` field of a
 * `ToolResultPayload` to keep ordering consistent.
 */
export function buildBufferOverflowHint(msg: string): string | null {
  const m = BUFFER_OVERFLOW_RE.exec(msg);
  if (!m) return null;
  const requiredBytes = parseInt(m[1], 10);
  const suggestedKb = suggestedKbForBytes(requiredBytes);
  return (
    `  ${C.warn("💡 The data exceeded the sandbox buffer size.")}\n` +
    `     Try increasing the buffer:\n` +
    `       ${C.val("/buffer output " + suggestedKb)}  — if result data is too large\n` +
    `       ${C.val("/buffer input " + suggestedKb)}   — if code being sent is too large`
  );
}

/**
 * If `msg` matches the Hyperlight buffer overflow error pattern, print
 * a user-actionable suggestion to increase the relevant buffer.
 *
 * Legacy entry point — newer code should prefer
 * {@link buildBufferOverflowHint} so the hint string can be plumbed
 * through the UI port.
 */
export function suggestBufferIncreaseIfNeeded(msg: string): void {
  const hint = buildBufferOverflowHint(msg);
  if (hint) console.log(hint);
}
