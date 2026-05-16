// ── agent/attachments.ts — User-attachment resolution ────────────────
//
// Resolves user-provided file paths (from `--attach FILE` and, in
// future, the `/attach` slash command) into the typed attachment
// objects the Copilot SDK accepts on `session.send()`.
//
// The SDK supports four attachment shapes (`file`, `directory`,
// `selection`, `blob`). This module currently only emits `file`
// attachments — the only kind reachable from the CLI surface today.
// The other shapes belong to richer UIs (Electron paste-image →
// `blob`; IDE-style code-region picker → `selection`) and will hook
// in when those UIs land.
//
// The SDK reads, MIME-sniffs, and uploads files itself — we just
// hand it absolute paths plus a human-friendly `displayName`.
//
// Pure module — no I/O beyond `statSync` for the existence check,
// and no agent-state imports. Safe to call from CLI startup.
// ────────────────────────────────────────────────────────────────────

import { statSync } from "node:fs";
import { resolve as resolvePath, basename } from "node:path";
import type { MessageOptions } from "@github/copilot-sdk";

/**
 * One element of `MessageOptions.attachments`. The SDK declares this
 * as an inline anonymous union; deriving it keeps us in lock-step if
 * the SDK adds a fifth attachment kind.
 */
export type SessionAttachment = NonNullable<
  MessageOptions["attachments"]
>[number];

/**
 * Resolve a single user-supplied path into a `file` attachment.
 *
 * - Relative paths are resolved against the current working directory.
 * - The path must exist and be a regular file. Directories are
 *   rejected (the SDK has a separate `directory` attachment type but
 *   `--attach` is scoped to files for v1; allowing a directory by
 *   accident would silently upload a whole tree).
 *
 * @param input — Path as provided by the user (relative or absolute).
 * @returns A typed `{ type: "file", path, displayName }` attachment.
 * @throws  An `Error` with a message prefixed by `--attach:` when the
 *          path cannot be resolved.
 */
export function resolveFileAttachment(input: string): SessionAttachment {
  const absPath = resolvePath(input);
  let stat;
  try {
    stat = statSync(absPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`--attach: cannot stat ${input}: ${msg}`);
  }
  if (stat.isDirectory()) {
    throw new Error(
      `--attach: ${input} is a directory; only files are supported`,
    );
  }
  if (!stat.isFile()) {
    throw new Error(`--attach: ${input} is not a regular file`);
  }
  return { type: "file", path: absPath, displayName: basename(absPath) };
}

/**
 * Resolve a list of user-supplied paths, preserving order. The first
 * failure aborts — callers can decide whether to surface the message
 * and exit, or skip the bad entry.
 *
 * @param inputs — Paths as provided by the user.
 * @returns Attachments in input order.
 */
export function resolveFileAttachments(inputs: string[]): SessionAttachment[] {
  return inputs.map(resolveFileAttachment);
}
