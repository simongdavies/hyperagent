// ── agent/pattern-loader.ts — PATTERN.md parser ─────────────────────
//
// Loads pattern definitions from patterns/<name>/PATTERN.md files.
// Each pattern specifies modules, plugins, profiles, config, and steps.
// Used by the suggest_approach resolver to materialise guidance.
//

// ─────────────────────────────────────────────────────────────────────

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── Types ────────────────────────────────────────────────────────────

/** A parsed pattern definition. */
export interface Pattern {
  /** Pattern name (directory name, e.g. "two-handler-pipeline"). */
  name: string;
  /** One-line description. */
  description: string;
  /** ha:* modules this pattern needs. */
  modules: string[];
  /** host:* plugins this pattern needs. */
  plugins: string[];
  /** Resource profiles to apply (e.g. "file-builder"). */
  profiles: string[];
  /** Config overrides (heapMb, scratchMb, cpuTimeoutMs, etc.). */
  config: Record<string, number>;
  /** Ordered implementation steps (from markdown body). */
  steps: string[];
}

// ── YAML Frontmatter Parser ──────────────────────────────────────────

/**
 * Parse simple YAML frontmatter between --- delimiters.
 * Returns the frontmatter key-value pairs and the body after the closing ---.
 * Handles string, number, and string[] (YAML list) values.
 */
function parseFrontmatter(content: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { meta: {}, body: content };
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return { meta: {}, body: content };
  }

  const meta: Record<string, unknown> = {};
  let currentKey = "";
  let currentList: string[] | null = null;

  for (let i = 1; i < endIdx; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) continue;

    // List item (indented with -)
    if (/^\s+-\s+/.test(line) && currentList !== null) {
      const value = trimmed.replace(/^-\s+/, "").trim();
      currentList.push(value);
      continue;
    }

    // Save previous list if any
    if (currentList !== null && currentKey) {
      meta[currentKey] = currentList;
      currentList = null;
    }

    // Key: value pair
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();
    currentKey = key;

    if (!rawValue) {
      // Value on next lines (could be a list or nested object)
      currentList = [];
      continue;
    }

    // Inline array: [a, b, c]
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      const inner = rawValue.slice(1, -1);
      meta[key] = inner
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }

    // Number
    const num = Number(rawValue);
    if (!isNaN(num) && rawValue !== "") {
      meta[key] = num;
      continue;
    }

    // String (strip quotes if present)
    meta[key] = rawValue.replace(/^["']|["']$/g, "");
  }

  // Save trailing list
  if (currentList !== null && currentKey) {
    meta[currentKey] = currentList;
  }

  const body = lines
    .slice(endIdx + 1)
    .join("\n")
    .trim();
  return { meta, body };
}

/**
 * Parse numbered steps from markdown body.
 * Lines starting with "1. ", "2. " etc. become steps.
 * Other non-empty lines are appended to the previous step.
 */
function parseSteps(body: string): string[] {
  const steps: string[] = [];
  const lines = body.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Numbered step: "1. Do something"
    const stepMatch = trimmed.match(/^\d+\.\s+(.+)/);
    if (stepMatch) {
      steps.push(stepMatch[1]);
    } else if (steps.length > 0 && !trimmed.startsWith("#")) {
      // Continuation of previous step
      steps[steps.length - 1] += " " + trimmed;
    }
  }

  return steps;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Load all patterns from a directory.
 * Each subdirectory should contain a PATTERN.md file.
 *
 * @param dir - Path to patterns directory (e.g. "./patterns")
 * @returns Map of pattern name → Pattern
 */
export function loadPatterns(dir: string): Map<string, Pattern> {
  const patterns = new Map<string, Pattern>();

  if (!existsSync(dir)) return patterns;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const patternFile = join(dir, entry.name, "PATTERN.md");
    if (!existsSync(patternFile)) continue;

    const content = readFileSync(patternFile, "utf-8");
    const { meta, body } = parseFrontmatter(content);

    const name = (meta.name as string) || entry.name;
    const description = (meta.description as string) || "";

    // Extract arrays with defaults
    const modules = Array.isArray(meta.modules)
      ? (meta.modules as string[])
      : [];
    const plugins = Array.isArray(meta.plugins)
      ? (meta.plugins as string[])
      : [];
    const profiles = Array.isArray(meta.profiles)
      ? (meta.profiles as string[])
      : [];

    // Extract config object
    const config: Record<string, number> = {};
    if (meta.config && typeof meta.config === "object") {
      // Config was parsed as nested — but our simple parser doesn't do nested YAML.
      // Handle inline config keys like "heapMb: 128" at the top level of frontmatter.
    }
    // Top-level config keys (heapMb, scratchMb, cpuTimeoutMs, wallTimeoutMs)
    for (const configKey of [
      "heapMb",
      "scratchMb",
      "cpuTimeoutMs",
      "wallTimeoutMs",
      "inputBufferKb",
      "outputBufferKb",
    ]) {
      if (typeof meta[configKey] === "number") {
        config[configKey] = meta[configKey] as number;
      }
    }

    const steps = parseSteps(body);

    patterns.set(name, {
      name,
      description,
      modules,
      plugins,
      profiles,
      config,
      steps,
    });
  }

  return patterns;
}
