// ── Module Hints Integrity Tests ─────────────────────────────────────
//
// Validates that:
// 1. Every module JSON has a hints section with at least overview
// 2. relatedModules references are bidirectional
// 3. relatedModules point to real modules
// 4. requiredPlugins point to real plugins
//
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const BUILTIN_DIR = join(import.meta.dirname, "..", "builtin-modules");

// Private/internal modules that don't need hints
const PRIVATE_MODULES = new Set(["_restore", "_save"]);

// Load all module JSONs
const moduleJsons = new Map<
  string,
  {
    name: string;
    hints?: {
      overview?: string;
      relatedModules?: string[];
      requiredPlugins?: string[];
      optionalPlugins?: string[];
      criticalRules?: string[];
      antiPatterns?: string[];
      commonPatterns?: string[];
    };
  }
>();

for (const file of readdirSync(BUILTIN_DIR)) {
  if (!file.endsWith(".json") || file === "tsconfig.json") continue;
  const name = file.replace(".json", "");
  if (PRIVATE_MODULES.has(name)) continue;
  const content = JSON.parse(readFileSync(join(BUILTIN_DIR, file), "utf-8"));
  moduleJsons.set(name, content);
}

// All public module names (for reference validation)
const allModuleNames = new Set(moduleJsons.keys());

describe("module-hints-integrity", () => {
  describe("every module has hints with overview", () => {
    for (const [name, meta] of moduleJsons) {
      it(`${name} has hints.overview`, () => {
        expect(
          meta.hints,
          `Module "${name}" is missing hints section in its .json file`,
        ).toBeDefined();
        expect(
          meta.hints?.overview,
          `Module "${name}" hints is missing overview`,
        ).toBeTruthy();
      });
    }
  });

  describe("relatedModules point to real modules", () => {
    for (const [name, meta] of moduleJsons) {
      if (!meta.hints?.relatedModules?.length) continue;
      for (const related of meta.hints.relatedModules) {
        // Strip ha: prefix for lookup
        const relatedName = related.replace(/^ha:/, "");
        it(`${name} → ${related} exists`, () => {
          expect(
            allModuleNames.has(relatedName),
            `Module "${name}" references non-existent related module "${related}". ` +
              `Available: ${[...allModuleNames].join(", ")}`,
          ).toBe(true);
        });
      }
    }
  });

  describe("relatedModules are bidirectional", () => {
    for (const [name, meta] of moduleJsons) {
      if (!meta.hints?.relatedModules?.length) continue;
      for (const related of meta.hints.relatedModules) {
        const relatedName = related.replace(/^ha:/, "");
        const relatedMeta = moduleJsons.get(relatedName);
        if (!relatedMeta?.hints?.relatedModules) continue;

        it(`${name} ↔ ${related} (bidirectional)`, () => {
          const backRef = relatedMeta.hints?.relatedModules?.some(
            (r) => r.replace(/^ha:/, "") === name,
          );
          expect(
            backRef,
            `Module "${related}" lists "${name}" as related, but "${name}" ` +
              `doesn't list "${related}" back. Add "ha:${name}" to ${related}'s relatedModules.`,
          ).toBe(true);
        });
      }
    }
  });

  describe("requiredPlugins are valid plugin names", () => {
    // Known valid plugin names
    const VALID_PLUGINS = new Set(["fs-write", "fs-read", "fetch"]);

    for (const [name, meta] of moduleJsons) {
      if (!meta.hints?.requiredPlugins?.length) continue;
      for (const plugin of meta.hints.requiredPlugins) {
        it(`${name} requiredPlugin "${plugin}" is valid`, () => {
          expect(
            VALID_PLUGINS.has(plugin),
            `Module "${name}" requires unknown plugin "${plugin}". ` +
              `Valid plugins: ${[...VALID_PLUGINS].join(", ")}`,
          ).toBe(true);
        });
      }
    }
  });

  describe("compiled .js files do not export _HINTS", () => {
    const jsFiles = readdirSync(BUILTIN_DIR).filter(
      (f) => f.endsWith(".js") && !f.startsWith("_"), // skip internal modules
    );

    for (const file of jsFiles) {
      it(`${file} should not export _HINTS`, () => {
        const content = readFileSync(join(BUILTIN_DIR, file), "utf-8");
        // Check for both named export and property assignment patterns
        const hasHintsExport =
          /export\s+(const|let|var)\s+_HINTS\b/.test(content) ||
          /exports\._HINTS\s*=/.test(content) ||
          /Object\.defineProperty\(exports,\s*["']_HINTS["']/.test(content);
        expect(
          hasHintsExport,
          `${file} still exports _HINTS — remove it from the TypeScript source and rebuild`,
        ).toBe(false);
      });
    }
  });
});
