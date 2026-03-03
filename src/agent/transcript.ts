// ── Transcript — Session Recording ──────────────────────────────────
//
// Records everything the user sees to a timestamped log file in
// ~/.hyperagent/logs/. The raw .log preserves ANSI escape codes (viewable
// with `cat` or `less -R`). On close, a clean .txt is auto-generated
// with all escape codes stripped — opens perfectly in any editor.
//
// Usage (CLI):
//   npx hyperagent --transcript
//
// Usage (slash command):
//   /transcript          Toggle recording on/off
//
// ─────────────────────────────────────────────────────────────────────

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── ANSI Stripping ──────────────────────────────────────────────────

/**
 * Comprehensive regex for ALL ANSI/VT100 escape sequences:
 * - CSI sequences: \x1b[...X (colors, cursor movement, erase)
 * - OSC sequences: \x1b]...BEL (window title, hyperlinks)
 * - Simple escapes: \x1b followed by a single letter
 *
 * Preserves all UTF-8 characters (emojis, box-drawing, etc.).
 */
const ANSI_REGEX =
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]|\u001b\][^\u0007]*\u0007|\u001b./g;

/**
 * Strip all ANSI escape sequences from a string, preserving UTF-8
 * characters (emojis, box-drawing, mathematical symbols, etc.).
 *
 * @param text — Raw text potentially containing ANSI escape codes
 * @returns Clean text with all escape sequences removed
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

// ── Configuration ───────────────────────────────────────────────────

/** Session config snapshot embedded in the transcript header. */
export interface TranscriptConfig {
  model?: string;
  cpuTimeoutMs?: number;
  wallClockTimeoutMs?: number;
  heapSizeMb?: number;
  inputBufferKb?: number;
  outputBufferKb?: number;
}

// ── Header / Footer Builders ────────────────────────────────────────
// Exported as pure functions for testability.

/**
 * Build the transcript header with session metadata.
 *
 * @param startTime — Session start timestamp
 * @param config    — Optional config snapshot for the header
 * @returns Formatted header string
 */
export function buildHeader(
  startTime: Date,
  config?: TranscriptConfig,
): string {
  const timeStr = startTime.toLocaleString();
  const lines = [
    "",
    "══════════════════════════════════════════════════════════",
    "  HyperAgent Session Transcript",
    `  Started: ${timeStr}`,
  ];

  if (config) {
    const configParts: string[] = [];
    if (config.model) configParts.push(`Model: ${config.model}`);
    if (config.cpuTimeoutMs) configParts.push(`CPU: ${config.cpuTimeoutMs}ms`);
    if (config.wallClockTimeoutMs)
      configParts.push(`Wall: ${config.wallClockTimeoutMs}ms`);
    if (configParts.length) lines.push(`  ${configParts.join(" │ ")}`);

    const memParts: string[] = [];
    if (config.heapSizeMb) memParts.push(`Heap: ${config.heapSizeMb}MB`);
    if (config.inputBufferKb) memParts.push(`In: ${config.inputBufferKb}KB`);
    if (config.outputBufferKb) memParts.push(`Out: ${config.outputBufferKb}KB`);
    if (memParts.length) lines.push(`  ${memParts.join(" │ ")}`);
  }

  lines.push("══════════════════════════════════════════════════════════");
  lines.push("");
  return lines.join("\n") + "\n";
}

/**
 * Build the transcript footer with session duration.
 *
 * @param startTime — Session start timestamp (used so test can calculate the delta)
 * @returns Formatted footer string
 */
export function buildFooter(startTime: Date): string {
  const endTime = new Date();
  const durationMs = endTime.getTime() - startTime.getTime();
  const durationSec = Math.round(durationMs / 1000);
  const mins = Math.floor(durationSec / 60);
  const secs = durationSec % 60;
  const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  return [
    "",
    "══════════════════════════════════════════════════════════",
    `  Session ended: ${endTime.toLocaleString()}`,
    `  Duration: ${duration}`,
    "══════════════════════════════════════════════════════════",
    "",
  ].join("\n");
}

// ── Transcript Class ────────────────────────────────────────────────

/**
 * Records all terminal output to a log file. Monkey-patches
 * process.stdout.write and process.stderr.write to intercept output
 * transparently — no changes needed at individual call sites.
 *
 * On stop, reads the raw .log and generates a clean .txt with all
 * ANSI escape codes stripped. Emojis, box-drawing, and other UTF-8
 * characters are preserved.
 */
export class Transcript {
  private stream: fs.WriteStream | null = null;
  private logPath = "";
  private startTime = new Date();
  private origStdoutWrite: typeof process.stdout.write | null = null;
  private origStderrWrite: typeof process.stderr.write | null = null;
  private _active = false;

  /** Whether the transcript is actively recording. */
  get active(): boolean {
    return this._active;
  }

  /** Path to the raw ANSI log file. Empty if not started. */
  get rawPath(): string {
    return this.logPath;
  }

  /** Path to the clean (ANSI-stripped) text file. Empty if not started. */
  get cleanPath(): string {
    return this.logPath ? this.logPath.replace(/\.log$/, ".txt") : "";
  }

  /**
   * Start recording. Creates a timestamped log file in ~/.hyperagent/logs/
   * and monkey-patches stdout/stderr to tee all output.
   *
   * @param config — Optional session config for the transcript header
   * @returns Path to the raw ANSI log file
   */
  start(config?: TranscriptConfig): string {
    if (this._active) return this.logPath;

    // Generate timestamped filename in the central logs directory.
    const LOGS_DIR = path.join(os.homedir(), ".hyperagent", "logs");
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, "0");
    const ts = [
      now.getFullYear(),
      pad(now.getMonth() + 1),
      pad(now.getDate()),
      "-",
      pad(now.getHours()),
      pad(now.getMinutes()),
      pad(now.getSeconds()),
    ].join("");

    this.logPath = path.join(LOGS_DIR, `hyperagent-${ts}.log`);
    this.startTime = now;
    this._active = true;

    // 0o600 — owner read/write only. Transcripts may contain
    // sensitive conversation content and should not be world-readable.
    this.stream = fs.createWriteStream(this.logPath, {
      encoding: "utf8",
      mode: 0o600,
    });

    // Write transcript header
    this.writeRaw(buildHeader(this.startTime, config));

    // ── Monkey-patch stdout ──────────────────────────────────
    // Captures: console.log, process.stdout.write, readline echo
    this.origStdoutWrite = process.stdout.write.bind(
      process.stdout,
    ) as typeof process.stdout.write;

    process.stdout.write = ((
      chunk: string | Uint8Array,
      ...args: unknown[]
    ): boolean => {
      this.writeRaw(String(chunk));
      return (this.origStdoutWrite as (...a: unknown[]) => boolean).call(
        process.stdout,
        chunk,
        ...args,
      );
    }) as typeof process.stdout.write;

    // ── Monkey-patch stderr ──────────────────────────────────
    // Captures: timing display, code display (console.error).
    // Skips [DEBUG] lines — too noisy for the transcript.
    this.origStderrWrite = process.stderr.write.bind(
      process.stderr,
    ) as typeof process.stderr.write;

    process.stderr.write = ((
      chunk: string | Uint8Array,
      ...args: unknown[]
    ): boolean => {
      const text = String(chunk);
      if (!text.includes("[DEBUG]")) {
        this.writeRaw(text);
      }
      return (this.origStderrWrite as (...a: unknown[]) => boolean).call(
        process.stderr,
        chunk,
        ...args,
      );
    }) as typeof process.stderr.write;

    return this.logPath;
  }

  /**
   * Stop recording (async). Writes footer, restores stdout/stderr,
   * closes the stream, and generates the ANSI-stripped .txt file.
   *
   * @returns Paths to both the raw .log and clean .txt files
   */
  async stop(): Promise<{ logPath: string; txtPath: string }> {
    if (!this._active || !this.stream) {
      return { logPath: "", txtPath: "" };
    }

    // Write footer while we still have the stream open AND
    // _active is still true (writeRaw checks this flag)
    this.writeRaw(buildFooter(this.startTime));

    // NOW mark as inactive — after the footer is written
    this._active = false;

    // Restore original write functions BEFORE closing so
    // post-stop console output goes to the real streams
    this.restoreStreams();

    // Close the write stream and wait for flush
    await new Promise<void>((resolve) => {
      this.stream!.end(() => resolve());
    });
    this.stream = null;

    // Generate the ANSI-stripped .txt version
    return this.generateCleanCopy();
  }

  /**
   * Stop recording (synchronous). Used in SIGINT handlers where
   * async operations may not complete before process.exit().
   *
   * @returns Paths to both files (txtPath may be empty on error)
   */
  stopSync(): { logPath: string; txtPath: string } {
    if (!this._active) {
      return { logPath: this.logPath, txtPath: "" };
    }
    this._active = false;

    // Build footer before we destroy the stream
    const footer = buildFooter(this.startTime);

    // Restore streams FIRST so subsequent console output goes
    // to the real stdout/stderr, not into the transcript
    this.restoreStreams();

    // Destroy the write stream (don't wait for flush)
    if (this.stream) {
      this.stream.destroy();
      this.stream = null;
    }

    // Append footer directly to the file (synchronous)
    try {
      fs.appendFileSync(this.logPath, footer, "utf8");
    } catch {
      // Best-effort — file may be locked or gone
    }

    // Generate clean copy synchronously
    return this.generateCleanCopy();
  }

  // ── Private Helpers ──────────────────────────────────────────

  /** Write raw text to the transcript stream. */
  private writeRaw(text: string): void {
    if (this.stream && this._active) {
      this.stream.write(text);
    }
  }

  /** Restore the original stdout/stderr.write functions. */
  private restoreStreams(): void {
    if (this.origStdoutWrite) {
      process.stdout.write = this.origStdoutWrite;
      this.origStdoutWrite = null;
    }
    if (this.origStderrWrite) {
      process.stderr.write = this.origStderrWrite;
      this.origStderrWrite = null;
    }
  }

  /**
   * Read the raw .log and write the ANSI-stripped .txt.
   *
   * @returns Paths to both files
   */
  private generateCleanCopy(): { logPath: string; txtPath: string } {
    const txtPath = this.cleanPath;
    try {
      const raw = fs.readFileSync(this.logPath, "utf8");
      // Strip ANSI escape codes and stray carriage returns
      const clean = stripAnsi(raw).replace(/\r/g, "");
      // 0o600 — owner read/write only, matching the raw log.
      fs.writeFileSync(txtPath, clean, { encoding: "utf8", mode: 0o600 });
      return { logPath: this.logPath, txtPath };
    } catch {
      // Best-effort — return what we have
      return { logPath: this.logPath, txtPath: "" };
    }
  }
}
