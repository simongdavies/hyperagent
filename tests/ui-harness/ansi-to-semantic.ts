// ── tests/ui-harness/ansi-to-semantic.ts ────────────────────────────
//
// Convert raw terminal output (ANSI escape codes mixed with text)
// into a readable, deterministic string of *semantic tags* — so
// golden tests can compare meaningful colour/style intent rather
// than fragile byte sequences.
//
// Examples:
//   "\x1b[0;32m✅ ok\x1b[0m"      → "<green>✅ ok</green>"
//   "\x1b[1mlabel\x1b[0m"          → "<bold>label</bold>"
//   "\r\x1b[2K"                    → "<clear-line>"
//   "\x1b]2;Title\x07"             → "<title:Title>"
//   "\x1b]8;;https://x\x07click\x1b]8;;\x07"
//                                  → "<link:https://x>click</link>"
//
// Any escape sequence we don't recognise is preserved as a raw
// `<ESC:...>` tag so unfamiliar output is visible in goldens
// rather than silently swallowed.
//
// This is intentionally a tiny hand-rolled parser — we want zero
// external dependencies in the test harness, and the C.* helpers
// in src/agent/ansi.ts emit a small fixed vocabulary.
// ────────────────────────────────────────────────────────────────────

/** ESC character (0x1B). */
const ESC = "\x1b";
/** BEL character (0x07) — terminates OSC sequences. */
const BEL = "\x07";

/**
 * SGR parameter codes we know how to translate to semantic tags.
 *
 * Keyed by the canonical parameter list (e.g. "0;32" for "reset, green").
 * Multiple parameter spellings may map to the same tag — e.g. "0;32"
 * and "32" both mean green; we normalise to whichever the C.* helpers
 * in src/agent/ansi.ts actually emit.
 *
 * The values are open-tag *names* (without angle brackets). A close
 * tag is always `</NAME>`. The special value `RESET` closes whichever
 * tag is currently open.
 */
const SGR_OPEN: Record<string, string> = {
  // Colours — match the exact escapes emitted by src/agent/ansi.ts.
  "0;31": "red",
  "0;32": "green",
  "1;33": "yellow",
  "0;36": "cyan",
  "0;35": "magenta",
  "0;34": "blue",
  // Styles
  "1": "bold",
  "2": "dim",
  "3": "italic",
  "4": "underline",
};

/** Canonical reset code: closes whatever style stack is active. */
const SGR_RESET = "0";

/**
 * Translate a single ANSI escape sequence (without the leading ESC)
 * into a semantic tag, given the current open-tag stack.
 *
 * Mutates `stack` to track which tag should be closed by `RESET`.
 * Returns the tag string to emit (or empty string for no-ops).
 */
function translateSequence(raw: string, stack: string[]): string {
  // ── CSI (Control Sequence Introducer): ESC [ params final ────────

  // SGR: ESC [ params m
  const sgr = raw.match(/^\[([0-9;]*)m$/);
  if (sgr) {
    const params = sgr[1];
    if (params === SGR_RESET || params === "") {
      // Close all currently-open tags, innermost first.
      const close = stack
        .reverse()
        .map((t) => `</${t}>`)
        .join("");
      stack.length = 0;
      return close;
    }
    const tagName = SGR_OPEN[params];
    if (tagName) {
      stack.push(tagName);
      return `<${tagName}>`;
    }
    // Unknown SGR — surface it so the test author notices.
    return `<ESC:CSI:${params}m>`;
  }

  // Clear line: ESC [ 2 K
  if (raw === "[2K") return "<clear-line>";
  // Clear to end of line: ESC [ K  (default param = 0)
  if (raw === "[K") return "<clear-line-eol>";
  // Cursor up N: ESC [ <N> A   (N defaults to 1)
  const up = raw.match(/^\[(\d*)A$/);
  if (up) return up[1] === "" || up[1] === "1" ? "<up>" : `<up:${up[1]}>`;
  // Cursor down N: ESC [ <N> B
  const down = raw.match(/^\[(\d*)B$/);
  if (down)
    return down[1] === "" || down[1] === "1" ? "<down>" : `<down:${down[1]}>`;

  // Other CSI sequences — preserve visibly for debugging.
  const csi = raw.match(/^\[(.*)$/);
  if (csi) return `<ESC:CSI:${csi[1]}>`;

  // ── OSC (Operating System Command): ESC ] params BEL ─────────────
  const osc = raw.match(/^\](.*)$/);
  if (osc) {
    const body = osc[1];
    // Window title: ESC ] 2 ; TITLE BEL
    const title = body.match(/^2;(.*)$/);
    if (title) return `<title:${title[1]}>`;
    // OSC 8 hyperlink: ESC ] 8 ; ; URI BEL
    const link = body.match(/^8;;(.*)$/);
    if (link) {
      // Empty URI is the close form: `\x1b]8;;\x07`
      return link[1] === "" ? "</link>" : `<link:${link[1]}>`;
    }
    return `<ESC:OSC:${body}>`;
  }

  return `<ESC:${raw}>`;
}

/**
 * Read one ANSI escape sequence starting at `s[i]` (which must be ESC).
 *
 * Returns the raw sequence body (everything after ESC, up to and
 * including its terminator) along with the byte index just past it.
 *
 * Supports:
 *   - CSI:  ESC [ <params> <final-byte 0x40-0x7E>
 *   - OSC:  ESC ] <params> <BEL>     (we don't bother with ST terminator)
 *
 * If the sequence is malformed/truncated we return the lone ESC byte
 * as its own "sequence" — translateSequence will preserve it as
 * `<ESC:>` so the test author sees something is up.
 */
function readEscapeSequence(
  s: string,
  i: number,
): { body: string; next: number } {
  // i points at ESC. Look at the next byte to decide which kind.
  const introducer = s[i + 1];
  if (introducer === "[") {
    // CSI — params are 0x30-0x3F, terminator is 0x40-0x7E.
    let j = i + 2;
    while (j < s.length) {
      const code = s.charCodeAt(j);
      if (code >= 0x40 && code <= 0x7e) {
        return { body: s.slice(i + 1, j + 1), next: j + 1 };
      }
      j++;
    }
    // Unterminated — return what we have.
    return { body: s.slice(i + 1), next: s.length };
  }
  if (introducer === "]") {
    // OSC — terminated by BEL.
    const end = s.indexOf(BEL, i + 2);
    if (end === -1) {
      return { body: s.slice(i + 1), next: s.length };
    }
    return { body: s.slice(i + 1, end), next: end + 1 };
  }
  // Lone ESC or unsupported introducer.
  return { body: "", next: i + 1 };
}

/**
 * Convert raw terminal output to a semantic-tag string.
 *
 * Determinism: this is a pure function. Same input → same output.
 *
 * @param input - Raw bytes captured from process.stdout / process.stderr.
 * @returns A readable string with ANSI sequences replaced by tags.
 */
export function ansiToSemantic(input: string): string {
  const out: string[] = [];
  const stack: string[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    // Spinner-style "redraw the line": '\r' often precedes a clear-line.
    // Treat it as a tag so it shows up in goldens (cursor moves matter
    // for terminal output golden tests).
    if (ch === "\r") {
      out.push("<cr>");
      i++;
      continue;
    }

    if (ch === ESC) {
      const { body, next } = readEscapeSequence(input, i);
      out.push(translateSequence(body, stack));
      i = next;
      continue;
    }

    out.push(ch);
    i++;
  }

  // If the producer forgot a reset, leave the open tags visible so
  // the test fails loudly instead of silently suppressing styling.
  while (stack.length > 0) {
    const name = stack.pop()!;
    out.push(`<UNCLOSED:${name}>`);
  }

  return out.join("");
}
