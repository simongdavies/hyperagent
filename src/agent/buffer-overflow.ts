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

/**
 * If `msg` matches the Hyperlight buffer overflow error pattern, print
 * a user-actionable suggestion to increase the relevant buffer.
 */
export function suggestBufferIncreaseIfNeeded(msg: string): void {
  const m = BUFFER_OVERFLOW_RE.exec(msg);
  if (!m) return;

  // Convert required bytes → KB, rounded up with some headroom.
  const requiredBytes = parseInt(m[1], 10);
  const suggestedKb = Math.ceil((requiredBytes * 1.25) / 1024);

  console.log(
    `  ${C.warn("💡 The data exceeded the sandbox buffer size.")}\n` +
      `     Try increasing the buffer:\n` +
      `       ${C.val("/buffer output " + suggestedKb)}  — if result data is too large\n` +
      `       ${C.val("/buffer input " + suggestedKb)}   — if code being sent is too large`,
  );
}
