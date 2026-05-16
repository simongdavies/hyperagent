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

import type { TerminalOutputListener } from "./ui/terminal-ui.js";

// ── Transcript Host ─────────────────────────────────────────────────

/**
 * Anything the `Transcript` can subscribe to in order to capture
 * the user-visible byte stream.
 *
 * `TerminalUI` is the canonical implementation; the indirection lets
 * the transcript class stay decoupled from the concrete UI and lets
 * tests inject a stub. Future ports (e.g. `JsonLinesUI`) can opt in
 * by exposing the same shape if they want their output recorded.
 */
export interface TranscriptHost {
  /**
   * Register a listener that will receive every chunk the host
   * writes to stdout. The returned function unsubscribes.
   */
  addOutputListener(listener: TerminalOutputListener): () => void;
}

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
 * Records the user-visible terminal output to a log file.
 *
 * **Stdout capture** happens through a registered `TranscriptHost`
 * (typically `TerminalUI`). Call `attachTo(host)` once after the UI
 * is constructed and the transcript will subscribe to the host's
 * `addOutputListener` channel on every `start()`. This replaces an
 * earlier implementation that monkey-patched `process.stdout.write`
 * globally — that approach interfered with the typed AgentUI port
 * and made the recording capture stray writes from other agents'
 * tests when run in-process.
 *
 * **Stderr capture** still uses a targeted monkey-patch on
 * `process.stderr.write` (skipping `[DEBUG]` lines). Stderr is an
 * orthogonal channel — none of the UI ports write to it — so the
 * patch is safe and lets the transcript pick up startup console
 * errors from MCP / plugin initialisation that don't flow through
 * the UI.
 *
 * On stop, reads the raw .log and generates a clean .txt with all
 * ANSI escape codes stripped. Emojis, box-drawing, and other UTF-8
 * characters are preserved.
 *
 * Note: writes that bypass the host (direct `process.stdout.write`
 * call sites in the agent that haven't yet migrated to the UI port)
 * are not captured. Those leak sites are tracked in the ongoing
 * Phase 2 UI-port migration.
 */
export class Transcript implements TerminalOutputListener {
  private stream: fs.WriteStream | null = null;
  private logPath = "";
  private startTime = new Date();
  private origStderrWrite: typeof process.stderr.write | null = null;
  private _active = false;
  /**
   * Host the transcript subscribes to on `start()`. Bound once via
   * `attachTo` (typically at module init, immediately after the
   * `TerminalUI` instance is created). Optional — without a host
   * the transcript records only the header and footer.
   */
  private _host: TranscriptHost | null = null;
  /** Cancellation function returned by `host.addOutputListener`. */
  private _unsubscribe: (() => void) | null = null;

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
   * Bind the transcript to a host whose stdout stream should be
   * captured. Safe to call before or after `start()` — the
   * subscription is (re-)established on the next `start()`. Call
   * with `null` to detach.
   *
   * Typically invoked once at module init, immediately after the
   * primary `TerminalUI` is constructed.
   */
  attachTo(host: TranscriptHost | null): void {
    // If we're already recording and the host changes, swap the
    // subscription atomically so we don't lose bytes from the new
    // host or keep echoing from the old one.
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    this._host = host;
    if (this._active && host) {
      this._unsubscribe = host.addOutputListener(this);
    }
  }

  // ── TerminalOutputListener interface ─────────────────────────

  /**
   * Receive a chunk from the attached host and append it to the
   * raw log. No-op when the transcript is inactive — matches the
   * old monkey-patch's behaviour of only intercepting between
   * `start()` and `stop()`.
   */
  write(chunk: string): void {
    this.writeRaw(chunk);
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

    // ── Subscribe to the host (stdout-equivalent stream) ────
    // Replaces the old `process.stdout.write` monkey-patch.
    // If no host has been attached the transcript records only
    // the header + footer; bytes the host emits between start and
    // stop are forwarded via the `TerminalOutputListener.write`
    // method this class implements.
    if (this._host) {
      this._unsubscribe = this._host.addOutputListener(this);
    }

    // ── Monkey-patch stderr ──────────────────────────────────
    // Captures: timing display, code display (console.error).
    // Skips [DEBUG] lines — too noisy for the transcript.
    //
    // Stderr is the only remaining patched channel; the UI ports
    // don't write here, so the patch is non-invasive and lets the
    // transcript record startup messages from MCP/plugins.
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

    // Unsubscribe from the host and restore stderr BEFORE
    // closing so post-stop output goes to the real streams
    // (and doesn't reach this dying transcript instance).
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
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

    // Unsubscribe from the host and restore stderr FIRST so
    // subsequent console output goes to the real stdout/stderr,
    // not into this dying transcript instance.
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
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

  /** Restore the original stderr.write function. */
  private restoreStreams(): void {
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
