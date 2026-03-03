// ── plugins/shared/path-jail.ts — Path validation for jailed plugins ─
//
// Defence-in-depth path validation that ensures guest-supplied paths
// cannot escape a designated base directory. Used by plugins that
// need filesystem access (fs-write, zip-builder, library import).
//
// NOTE: fs-read and fs-write keep INLINE COPIES of this logic so the
// plugin auditor can see all code in a single index.ts file. New
// plugins should import from here instead of duplicating.
//
// When the auditor is enhanced to follow imports from plugins/shared/,
// the inline copies can be replaced with imports.
// ─────────────────────────────────────────────────────────────────────

import { existsSync, lstatSync, realpathSync } from "node:fs";
import {
  resolve,
  relative,
  dirname,
  basename,
  sep,
  join,
  isAbsolute,
} from "node:path";

/** Maximum path length accepted from guests (Linux PATH_MAX). */
const MAX_PATH_LENGTH = 4096;

/** Default hard ceiling for numeric config values (10 MB in KB). */
const DEFAULT_SIZE_CEILING_KB = 10240;

/** Result of path validation. */
export interface PathValidationResult {
  valid: boolean;
  realPath?: string;
  error?: string;
}

/**
 * Safely parse a numeric config value. Rejects NaN, Infinity, and
 * negative values. Falls back to the provided default.
 *
 * @param value — Raw config value
 * @param def — Default if value is null/undefined/invalid
 * @param ceil — Hard ceiling (default: 10240 KB / 10 MB)
 * @returns Sanitized numeric value
 */
export function safeNumericConfig(
  value: unknown,
  def: number,
  ceil: number = DEFAULT_SIZE_CEILING_KB,
): number {
  const raw = (value ?? def) as number;
  if (!Number.isFinite(raw) || raw < 0) return def;
  return Math.min(raw, ceil);
}

/**
 * Check whether a resolved path escapes the jail boundary.
 *
 * @param absPath — Resolved absolute path to test
 * @param baseDir — Jail root directory
 * @returns true if the path is outside the jail
 */
export function isOutsideJail(absPath: string, baseDir: string): boolean {
  const rel = relative(baseDir, absPath);
  return rel.startsWith("..") || isAbsolute(rel);
}

/**
 * Validate that a path is within the allowed base directory.
 *
 * Defence-in-depth:
 *   1. Type check — must be a non-empty string.
 *   2. resolve(baseDir, path) to absolute — guest paths are relative
 *      to the jail root, NOT process.cwd().
 *   3. Reject if the NORMALISED path still contains `..`.
 *   4. Reject symlinks outright via lstatSync.
 *   5. Boundary check: relative(base, abs) must not escape.
 *   6. Dotfile check — on every path component WITHIN the jail.
 *   7. Canonical path verification via realpathSync.
 *   8. Error messages are sanitised — guest never sees real host paths.
 *
 * @param targetPath — Raw path from the guest
 * @param baseDir — Resolved allowed base directory
 * @returns Validation result with realPath on success, error on failure
 */
export function validatePath(
  targetPath: string,
  baseDir: string,
): PathValidationResult {
  try {
    // Step 1: Type guard
    if (typeof targetPath !== "string" || targetPath.length === 0) {
      return {
        valid: false,
        error: "Invalid path: must be a non-empty string",
      };
    }

    // Step 1b: Null-byte guard
    if (targetPath.includes("\0")) {
      return { valid: false, error: "Access denied: invalid path character" };
    }

    // Step 1c: Path length limit
    if (targetPath.length > MAX_PATH_LENGTH) {
      return { valid: false, error: "Invalid path: exceeds maximum length" };
    }

    // Step 2: resolve against BASEDIR, not CWD
    const absPath = resolve(baseDir, targetPath);

    // Step 3: Belt-and-braces — reject surviving ".." segments
    const segments = absPath.split(sep);
    if (segments.some((s) => s === "..")) {
      return { valid: false, error: "Access denied: path traversal detected" };
    }

    // Step 4: Reject symlinks (no following, no resolution)
    try {
      if (existsSync(absPath)) {
        const lst = lstatSync(absPath);
        if (lst.isSymbolicLink()) {
          return {
            valid: false,
            error: "Access denied: symlinks are not permitted",
          };
        }
      }
      // Check every ancestor component for symlinks too.
      // Stop at baseDir — ancestors above the jail were validated
      // at registration time.
      let current = absPath;
      while (current !== dirname(current)) {
        current = dirname(current);
        if (current === baseDir) break;
        try {
          const parentStat = lstatSync(current);
          if (parentStat.isSymbolicLink()) {
            return {
              valid: false,
              error: "Access denied: symlinks are not permitted",
            };
          }
        } catch (walkErr: unknown) {
          const err = walkErr as NodeJS.ErrnoException | null;
          if (err && err.code === "ENOENT") {
            break;
          }
          return {
            valid: false,
            error: "Access denied: path validation failed",
          };
        }
      }
    } catch (outerErr: unknown) {
      const err = outerErr as NodeJS.ErrnoException | null;
      if (err && err.code !== "ENOENT") {
        return { valid: false, error: "Access denied: path validation failed" };
      }
    }

    // Step 5: Boundary check — must be within base dir
    if (isOutsideJail(absPath, baseDir)) {
      return {
        valid: false,
        error: "Access denied: path is outside allowed directory",
      };
    }

    // Step 6: Dotfile check — WITHIN the jail only
    const rel = relative(baseDir, absPath);
    const relSegments = rel.split(sep);
    for (const part of relSegments) {
      if (part.startsWith(".") && part !== "." && part !== "..") {
        return {
          valid: false,
          error: "Access denied: dotfile access is not permitted",
        };
      }
    }

    // Step 7: Canonical path verification
    try {
      if (existsSync(absPath)) {
        const canonical = realpathSync(absPath);
        if (isOutsideJail(canonical, baseDir)) {
          return {
            valid: false,
            error: "Access denied: path is outside allowed directory",
          };
        }
        return { valid: true, realPath: canonical };
      }
      // Non-existing path — canonicalize nearest existing ancestor
      let ancestor = absPath;
      let tail = "";
      while (!existsSync(ancestor)) {
        tail = tail ? join(basename(ancestor), tail) : basename(ancestor);
        const parent = dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
      if (existsSync(ancestor)) {
        const canonAncestor = realpathSync(ancestor);
        if (isOutsideJail(canonAncestor, baseDir)) {
          return {
            valid: false,
            error: "Access denied: path is outside allowed directory",
          };
        }
        return { valid: true, realPath: join(canonAncestor, tail) };
      }
    } catch {
      return { valid: false, error: "Access denied: path validation failed" };
    }

    return { valid: true, realPath: absPath };
  } catch {
    // Top-level catch — fail closed.
    return { valid: false, error: "Access denied: path validation failed" };
  }
}
