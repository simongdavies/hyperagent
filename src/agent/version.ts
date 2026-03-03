/**
 * MinVer-style version resolution for Hyperagent.
 *
 * Derives semantic version from git tags:
 * - On tag v0.1.0         → 0.1.0
 * - 5 commits after v0.1.0 → 0.1.1-alpha.5+abc1234
 * - No tags, 42 commits   → 0.0.0-alpha.42+abc1234
 * - Dirty working tree    → 0.1.1-alpha.5+abc1234.dirty
 *
 * For bundled binaries, version is injected at build time via esbuild --define.
 * For dev mode (tsx), version is calculated at runtime from git.
 */

import { execSync } from "node:child_process";

// Build-time injected constant (undefined in dev mode)
declare const __HYPERAGENT_VERSION__: string | undefined;

let cachedVersion: string | null = null;

/**
 * Parse git describe output into a semantic version.
 *
 * Input formats:
 * - "abc1234" (no tags)
 * - "abc1234-dirty" (no tags, dirty)
 * - "v0.1.0-0-gabc1234" (on tag)
 * - "v0.1.0-5-gabc1234" (5 commits after tag)
 * - "v0.1.0-5-gabc1234-dirty" (dirty)
 */
function parseGitDescribe(describe: string): string {
  const dirty = describe.endsWith("-dirty");
  const clean = describe.replace(/-dirty$/, "");

  // Just a commit hash (no tags exist)
  if (/^[a-f0-9]+$/i.test(clean)) {
    try {
      const count = execSync("git rev-list --count HEAD", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      return `0.0.0-alpha.${count}+${clean}${dirty ? ".dirty" : ""}`;
    } catch {
      return `0.0.0-alpha.0+${clean}${dirty ? ".dirty" : ""}`;
    }
  }

  // v0.1.0-5-gabc1234 format (git describe --tags --long output)
  const match = clean.match(/^v?(\d+\.\d+\.\d+)-(\d+)-g([a-f0-9]+)$/i);
  if (match) {
    const [, version, height, commit] = match;
    if (height === "0") {
      // Exactly on tag
      return dirty ? `${version}+dirty` : version;
    }
    // Bump patch for prerelease
    const [major, minor, patch] = version.split(".").map(Number);
    return `${major}.${minor}.${patch + 1}-alpha.${height}+${commit}${dirty ? ".dirty" : ""}`;
  }

  // Just a tag (git describe --tags without --long)
  const tagMatch = clean.match(/^v?(\d+\.\d+\.\d+)$/);
  if (tagMatch) {
    return dirty ? `${tagMatch[1]}+dirty` : tagMatch[1];
  }

  // Fallback
  return "0.0.0-dev";
}

/**
 * Calculate version using git describe.
 */
function calculateMinVer(): string {
  try {
    const describe = execSync("git describe --tags --long --always --dirty", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return parseGitDescribe(describe);
  } catch {
    // Not a git repo or git not available
    return "0.0.0-dev";
  }
}

/**
 * Get the current version string.
 * Uses build-time injected value if available, otherwise calculates from git.
 */
export function getVersion(): string {
  if (cachedVersion !== null) {
    return cachedVersion;
  }

  // Check for build-time injected version
  if (typeof __HYPERAGENT_VERSION__ !== "undefined") {
    cachedVersion = __HYPERAGENT_VERSION__;
    return cachedVersion;
  }

  // Dev mode: calculate from git
  cachedVersion = calculateMinVer();
  return cachedVersion;
}

/**
 * Get version string with 'v' prefix (e.g., "v0.1.0").
 */
export function getVersionString(): string {
  return `v${getVersion()}`;
}
