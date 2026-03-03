// ── agent/reverse-search.ts — Ctrl+R History Search ──────────────────
//
// Implements bash-style reverse incremental search (Ctrl+R) for the
// hyperagent REPL. As you type, it filters through command history
// and shows matching entries.
//
// ─────────────────────────────────────────────────────────────────────

import type { Interface as ReadlineInterface } from "node:readline/promises";
import { ANSI, C } from "./ansi.js";

// ── Constants ────────────────────────────────────────────────────────

const CTRL_R = "\x12";
const ESC = "\x1b";
const BACKSPACE = "\x7f";
const CTRL_H = "\x08";
const CTRL_C = "\x03";
const CTRL_G = "\x07";
// Move cursor to column 0, clear entire line, then clear any wrapped content above
const CURSOR_UP = "\x1b[A";
const CLEAR_LINE = "\r\x1b[2K";
const CLEAR_TO_END = "\x1b[J";

// ── Exported Helper ──────────────────────────────────────────────────

export function isCtrlR(key: string): boolean {
  return key === CTRL_R;
}

// ── Module State ─────────────────────────────────────────────────────
// Global state for the search - simpler than closures

let _searching = false;
let _searchTerm = "";
let _matchIndex = 0;
let _matches: string[] = [];
let _history: string[] = [];
let _prompt = "";
let _rl: ReadlineInterface | null = null;
let _prevLine = "";
let _allListeners: ((...args: unknown[]) => void)[] = [];
let _prevRenderLines = 1; // Track how many lines the previous render used

function updateMatches(): void {
  if (!_searchTerm) {
    _matches = [];
    _matchIndex = 0;
    return;
  }
  const lower = _searchTerm.toLowerCase();
  _matches = _history.filter((cmd) => cmd.toLowerCase().includes(lower));
  if (_matchIndex >= _matches.length) {
    _matchIndex = Math.max(0, _matches.length - 1);
  }
}

function render(): void {
  const currentMatch = _matches[_matchIndex] || "";
  const fail = _searchTerm && _matches.length === 0 ? "failing " : "";
  const searchPrompt = `(${fail}reverse-i-search)\`${_searchTerm}': `;

  let display = currentMatch;
  if (currentMatch && _searchTerm) {
    const idx = currentMatch.toLowerCase().indexOf(_searchTerm.toLowerCase());
    if (idx !== -1) {
      const before = currentMatch.slice(0, idx);
      const match = currentMatch.slice(idx, idx + _searchTerm.length);
      const after = currentMatch.slice(idx + _searchTerm.length);
      display = `${before}${ANSI.yellow}${ANSI.underline}${match}${ANSI.reset}${after}`;
    }
  }

  // Calculate how many terminal lines this will take (for proper clearing)
  const cols = process.stdout.columns || 80;
  const visibleLen = searchPrompt.length + currentMatch.length;
  const numLines = Math.ceil(visibleLen / cols) || 1;

  // Clear previous render: move up and clear each line if we used multiple lines before
  let clearSeq = "";
  for (let i = 1; i < _prevRenderLines; i++) {
    clearSeq += CURSOR_UP + CLEAR_LINE;
  }
  clearSeq += CLEAR_LINE;

  _prevRenderLines = numLines;

  process.stdout.write(`${clearSeq}${C.dim(searchPrompt)}${display}`);
}

function endSearch(command: string | null): void {
  // Remove our handler FIRST
  process.stdin.removeListener("data", searchHandler);

  // Clear the terminal line
  process.stdout.write(CLEAR_LINE);

  // Update readline's internal state
  const rlInternal = _rl as unknown as {
    line: string;
    cursor: number;
    _writeToOutput: (s: string) => void;
  };

  // Reset state BEFORE restoring listeners to prevent re-entry
  _searching = false;
  const listeners = _allListeners;
  _allListeners = [];

  // Restore original listeners FIRST so they can receive events
  for (const listener of listeners) {
    process.stdin.on("data", listener);
  }

  if (command) {
    // Set the command in readline's buffer
    rlInternal.line = command;
    rlInternal.cursor = command.length;
    // Show the prompt with the command
    process.stdout.write(_prompt + command);
    // Push a newline through stdin to trigger readline's normal 'line' event
    // This is the key - we let readline process the Enter naturally
    process.stdin.emit("data", Buffer.from("\r"));
  } else {
    // Cancelled - restore previous line content
    rlInternal.line = _prevLine;
    rlInternal.cursor = _prevLine.length;
    process.stdout.write(_prompt + _prevLine);
  }
}

function searchHandler(data: Buffer): void {
  const key = data.toString("utf8");

  // Ctrl+R: cycle matches
  if (key === CTRL_R) {
    if (_matches.length > 1) {
      _matchIndex = (_matchIndex + 1) % _matches.length;
    }
    render();
    return;
  }

  // Enter or Tab: accept
  if (key === "\r" || key === "\n" || key === "\t") {
    endSearch(_matches[_matchIndex] || null);
    return;
  }

  // ESC or arrow keys
  if (key.startsWith(ESC)) {
    // Right arrow: accept for editing (we'll treat same as enter for now)
    if (key === ESC + "[C") {
      endSearch(_matches[_matchIndex] || null);
      return;
    }
    // ESC alone or other sequences: cancel
    endSearch(null);
    return;
  }

  // Ctrl+C or Ctrl+G: cancel
  if (key === CTRL_C || key === CTRL_G) {
    endSearch(null);
    return;
  }

  // Backspace
  if (key === BACKSPACE || key === CTRL_H) {
    if (_searchTerm.length > 0) {
      _searchTerm = _searchTerm.slice(0, -1);
      _matchIndex = 0;
      updateMatches();
    }
    render();
    return;
  }

  // Printable
  if (key.length === 1 && key >= " ") {
    _searchTerm += key;
    _matchIndex = 0;
    updateMatches();
    render();
  }
}

function ctrlRHandler(data: Buffer): void {
  if (_searching) return;

  const key = data.toString("utf8");
  if (key !== CTRL_R) return;

  // Enter search mode
  _searching = true;
  _searchTerm = "";
  _matchIndex = 0;
  _matches = [];

  // Save readline state
  const rlInternal = _rl as unknown as { line: string; cursor: number };
  _prevLine = rlInternal.line || "";

  // Remove ALL listeners (including this one and readline's)
  _allListeners = process.stdin.listeners("data") as ((
    ...args: unknown[]
  ) => void)[];
  for (const listener of _allListeners) {
    process.stdin.removeListener("data", listener);
  }

  // Add our search handler
  process.stdin.on("data", searchHandler);

  // Clear and render
  process.stdout.write(CLEAR_LINE);
  render();
}

/**
 * Set up Ctrl+R handler.
 */
export function setupCtrlRHandler(
  rl: ReadlineInterface,
  getHistory: () => string[],
  prompt: string,
): (() => void) | null {
  if (!process.stdin.isTTY) {
    return null;
  }

  _rl = rl;
  _prompt = prompt;
  _history = []; // Will be updated on each search

  // Wrap getHistory to always get fresh history
  const originalHandler = ctrlRHandler;
  const wrappedHandler = (data: Buffer) => {
    _history = getHistory();
    originalHandler(data);
  };

  process.stdin.prependListener("data", wrappedHandler);

  return () => {
    process.stdin.removeListener("data", wrappedHandler);
  };
}
