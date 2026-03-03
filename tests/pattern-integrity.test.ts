// ── Pattern & Skill Integrity Tests ─────────────────────────────────
//
// Validates that:
// 1. Every pattern referenced by a skill actually exists
// 2. Every module in a pattern's modules[] array is a real builtin module
// 3. Pattern steps don't contain hardcoded ha:module function calls
//    (the LLM should discover APIs via module_info, not from prose)
//
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readdirSync } from "fs";
import { join } from "path";
import { loadSkills } from "../src/agent/skill-loader.js";
import { loadPatterns } from "../src/agent/pattern-loader.js";

const ROOT = join(import.meta.dirname, "..");
const SKILLS_DIR = join(ROOT, "skills");
const PATTERNS_DIR = join(ROOT, "patterns");
const BUILTIN_MODULES_DIR = join(ROOT, "builtin-modules");

// Builtin module names derived from .json metadata files (excluding tsconfig)
const builtinModuleNames = new Set(
  readdirSync(BUILTIN_MODULES_DIR)
    .filter((f) => f.endsWith(".json") && f !== "tsconfig.json")
    .map((f) => f.replace(/\.json$/, "")),
);

// Internal/private modules that shouldn't be referenced in patterns
const PRIVATE_MODULES = new Set(["_restore", "_save"]);

const skills = loadSkills(SKILLS_DIR);
const patterns = loadPatterns(PATTERNS_DIR);

describe("pattern-integrity", () => {
  describe("skill → pattern references", () => {
    for (const [skillName, skill] of skills) {
      for (const patternName of skill.patterns) {
        it(`skill "${skillName}" references existing pattern "${patternName}"`, () => {
          expect(
            patterns.has(patternName),
            `Pattern "${patternName}" referenced by skill "${skillName}" does not exist in ${PATTERNS_DIR}`,
          ).toBe(true);
        });
      }
    }
  });

  describe("pattern modules exist as builtin modules", () => {
    for (const [patternName, pattern] of patterns) {
      for (const moduleName of pattern.modules) {
        it(`pattern "${patternName}" module "${moduleName}" is a real builtin module`, () => {
          expect(
            builtinModuleNames.has(moduleName),
            `Module "${moduleName}" in pattern "${patternName}" is not in builtin-modules/. ` +
              `Available: ${[...builtinModuleNames].filter((m) => !PRIVATE_MODULES.has(m)).join(", ")}`,
          ).toBe(true);
        });

        it(`pattern "${patternName}" module "${moduleName}" is not a private module`, () => {
          expect(
            !PRIVATE_MODULES.has(moduleName),
            `Module "${moduleName}" in pattern "${patternName}" is a private/internal module`,
          ).toBe(true);
        });
      }
    }
  });

  describe("pattern steps do not hardcode ha:module API calls", () => {
    // Matches: ha:module-name functionName(args) — a specific module API call in prose.
    // This is the (a) option: only flag ha:module-name + function combos.
    const HA_MODULE_CALL_RE = /ha:\S+\s+\w+\([^)]*\)/;

    for (const [patternName, pattern] of patterns) {
      it(`pattern "${patternName}" steps should not contain ha:module function calls`, () => {
        const violations: string[] = [];
        for (const step of pattern.steps) {
          if (HA_MODULE_CALL_RE.test(step)) {
            violations.push(step);
          }
        }
        expect(
          violations,
          `Pattern "${patternName}" has hardcoded API calls in steps. ` +
            `Use descriptive intent instead (e.g. "parse HTML using ha:html"). ` +
            `Violations:\n${violations.map((v) => `  - ${v}`).join("\n")}`,
        ).toEqual([]);
      });
    }
  });
});
