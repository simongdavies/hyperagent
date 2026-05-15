// ── tests/ui-harness/capture-stdio.ts ───────────────────────────────
//
// Capture process.stdout / process.stderr / console.* writes into
// in-memory buffers so a test can assert on what *would* have hit
// the terminal.
//
// Why we patch *both* the streams and `console.*`
// ───────────────────────────────────────────────
// Node's `console.log` does NOT route through `process.stdout.write`
// at the JavaScript layer — it writes directly to the underlying
// stream's C++ binding. Vitest also installs its own `console.*`
// hook that captures and re-emits console output under each test
// name in the report — meaning a stream-only spy misses the bulk of
// the event handler's output.
//
// We therefore install spies at *both* layers and route everything
// into a single ordered buffer per stream. The result mirrors what
// the user would actually see on screen.
//
// Implementation notes:
//   - `vi.spyOn(...).mockImplementation(...)` auto-restores via the
//     spy's `mockRestore()` regardless of how the test exits.
//   - `util.format` is used for `console.*` to faithfully render
//     printf-style placeholders and object formatting, matching
//     Node's runtime behaviour.
//   - `restore()` is idempotent — safe to call from a `finally`
//     block even after a previous call.
//   - Captured output is the *raw* bytes — caller passes it through
//     `ansiToSemantic()` for golden comparison.
// ────────────────────────────────────────────────────────────────────

import { vi } from "vitest";
import { format as utilFormat } from "node:util";

/**
 * Result of `captureStdio()` — accessor functions for the captured
 * buffers plus a `restore()` to put the originals back.
 */
export interface StdioCapture {
  /** All bytes written to `process.stdout` since `captureStdio()` was called. */
  readonly stdout: () => string;
  /** All bytes written to `process.stderr` since `captureStdio()` was called. */
  readonly stderr: () => string;
  /** Restore the original `write` methods. Safe to call more than once. */
  readonly restore: () => void;
}

/**
 * Type of `process.stdout.write` — Node's `WriteStream.write` is
 * overloaded. We treat it as `unknown[] → boolean` for spying.
 */
type WriteFn = (chunk: string | Uint8Array, ...rest: unknown[]) => boolean;

/**
 * Coerce one write argument to a UTF-8 string for buffering.
 */
function chunkToString(chunk: string | Uint8Array): string {
  if (typeof chunk === "string") return chunk;
  return Buffer.from(chunk).toString("utf8");
}

/**
 * Install spies on `process.stdout.write` and `process.stderr.write`.
 *
 * While the spies are active, writes are *not* forwarded to the real
 * terminal — they are buffered for later inspection. Call `restore()`
 * to put the originals back (idempotent).
 *
 * Typical usage:
 *
 * ```ts
 * const cap = captureStdio();
 * try {
 *   doStuffThatWrites();
 *   expect(ansiToSemantic(cap.stdout())).toMatchFileSnapshot(...);
 * } finally {
 *   cap.restore();
 * }
 * ```
 */
export function captureStdio(): StdioCapture {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  // ── Stream-level spies ──────────────────────────────────────────
  // These catch direct `process.stdout.write` calls — spinner clear
  // sequences, streamed message_delta text, etc.

  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
    ..._rest: unknown[]
  ) => {
    stdoutChunks.push(chunkToString(chunk));
    return true;
  }) as WriteFn);

  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array,
    ..._rest: unknown[]
  ) => {
    stderrChunks.push(chunkToString(chunk));
    return true;
  }) as WriteFn);

  // ── Console-level spies ─────────────────────────────────────────
  // The event handler uses `console.log` for the majority of its
  // output (tool lines, usage stats, warnings, …). These calls
  // bypass the stream-level spies, so we mirror them into the same
  // buffers, mimicking Node's behaviour: format with util.format
  // and append a newline.

  const consoleLogSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      stdoutChunks.push(utilFormat(...args) + "\n");
    });

  const consoleInfoSpy = vi
    .spyOn(console, "info")
    .mockImplementation((...args: unknown[]) => {
      stdoutChunks.push(utilFormat(...args) + "\n");
    });

  const consoleWarnSpy = vi
    .spyOn(console, "warn")
    .mockImplementation((...args: unknown[]) => {
      stderrChunks.push(utilFormat(...args) + "\n");
    });

  const consoleErrorSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      stderrChunks.push(utilFormat(...args) + "\n");
    });

  let restored = false;
  return {
    stdout: () => stdoutChunks.join(""),
    stderr: () => stderrChunks.join(""),
    restore: () => {
      if (restored) return;
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      consoleLogSpy.mockRestore();
      consoleInfoSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      restored = true;
    },
  };
}
