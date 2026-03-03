// ── Plugin Audit Integration Tests ───────────────────────────────────
//
// Integration tests that run the static scanner against the real plugin
// source files (fs-read, fs-write, fetch). Validates that:
//
// 1. The Rust scanner runs without errors on real plugin code
// 2. Findings are returned in the expected format
// 3. No unexpected failures occur
//
// These tests exercise the canary migration by ensuring the audit
// infrastructure works against our existing plugins.
//
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { scanPlugin, checkAvailability } from "../src/agent/analysis-guest.js";
import {
  injectCanaries,
  verifyCanaries,
  parseAuditResponse,
} from "../src/plugin-system/auditor.js";
import type {
  AuditFinding,
  PluginManifest,
} from "../src/plugin-system/types.js";

// ── Test data ─────────────────────────────────────────────────────────

const PLUGINS_DIR = join(import.meta.dirname, "..", "plugins");

const PLUGINS = ["fs-read", "fs-write", "fetch"] as const;

interface PluginTestData {
  name: string;
  source: string;
  manifest: PluginManifest;
}

let pluginData: Map<string, PluginTestData>;
let scannerAvailable: boolean;

beforeAll(async () => {
  // Check if Rust scanner is available
  const availability = await checkAvailability();
  scannerAvailable = availability.available;

  // Load plugin sources and manifests
  pluginData = new Map();
  for (const name of PLUGINS) {
    const dir = join(PLUGINS_DIR, name);
    const indexPath = join(dir, "index.ts");
    const manifestPath = join(dir, "plugin.json");

    if (!existsSync(indexPath) || !existsSync(manifestPath)) {
      throw new Error(`Plugin ${name} not found at ${dir}`);
    }

    const source = readFileSync(indexPath, "utf8");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    pluginData.set(name, { name, source, manifest });
  }
});

// ── Static Scanner Tests ──────────────────────────────────────────────

describe("plugin static scanning", () => {
  it("fs-read: scanner runs without errors", async () => {
    if (!scannerAvailable) {
      console.log("Skipping: scanner not available");
      return;
    }
    const plugin = pluginData.get("fs-read")!;
    const result = await scanPlugin(plugin.source);

    expect(result).toBeDefined();
    expect(result.findings).toBeDefined();
    expect(Array.isArray(result.findings)).toBe(true);

    // fs-read uses node:fs — should have filesystem findings
    const hasFsFindings = result.findings.some(
      (f) => f.message.includes("filesystem") || f.message.includes("fs"),
    );
    expect(hasFsFindings).toBe(true);
  });

  it("fs-write: scanner runs without errors", async () => {
    if (!scannerAvailable) {
      console.log("Skipping: scanner not available");
      return;
    }
    const plugin = pluginData.get("fs-write")!;
    const result = await scanPlugin(plugin.source);

    expect(result).toBeDefined();
    expect(result.findings).toBeDefined();
    expect(Array.isArray(result.findings)).toBe(true);

    // fs-write uses node:fs — should have filesystem findings
    const hasFsFindings = result.findings.some(
      (f) => f.message.includes("filesystem") || f.message.includes("fs"),
    );
    expect(hasFsFindings).toBe(true);
  });

  it("fetch: scanner runs without errors", async () => {
    if (!scannerAvailable) {
      console.log("Skipping: scanner not available");
      return;
    }
    const plugin = pluginData.get("fetch")!;
    const result = await scanPlugin(plugin.source);

    expect(result).toBeDefined();
    expect(result.findings).toBeDefined();
    expect(Array.isArray(result.findings)).toBe(true);

    // fetch uses node:https — should have network-related findings
    const hasNetworkFindings = result.findings.some(
      (f) =>
        f.message.toLowerCase().includes("network") ||
        f.message.toLowerCase().includes("http") ||
        f.message.toLowerCase().includes("fetch"),
    );
    expect(hasNetworkFindings).toBe(true);
  });

  it("all findings have valid severity levels", async () => {
    if (!scannerAvailable) {
      console.log("Skipping: scanner not available");
      return;
    }
    const validSeverities = new Set(["info", "warning", "danger"]);

    for (const plugin of pluginData.values()) {
      const result = await scanPlugin(plugin.source);

      for (const finding of result.findings) {
        expect(validSeverities.has(finding.severity)).toBe(true);
        expect(typeof finding.message).toBe("string");
        expect(finding.message.length).toBeGreaterThan(0);
      }
    }
  });
});

// ── Canary Injection Tests ────────────────────────────────────────────

describe("canary injection on real plugins", () => {
  it("fs-read: canaries inject without breaking source structure", () => {
    const plugin = pluginData.get("fs-read")!;
    const result = injectCanaries(plugin.source);

    expect(result.uuid1).toBeTruthy();
    expect(result.uuid2).toBeTruthy();
    expect(result.source).toContain(result.uuid1);
    expect(result.source).toContain(result.uuid2);
    // Original code should still be present
    expect(result.source).toContain("export function createHostFunctions");
    expect(result.source).toContain("fs-read");
  });

  it("fs-write: canaries inject without breaking source structure", () => {
    const plugin = pluginData.get("fs-write")!;
    const result = injectCanaries(plugin.source);

    expect(result.uuid1).toBeTruthy();
    expect(result.uuid2).toBeTruthy();
    expect(result.source).toContain(result.uuid1);
    expect(result.source).toContain(result.uuid2);
    // Original code should still be present
    expect(result.source).toContain("export function createHostFunctions");
    expect(result.source).toContain("fs-write");
  });

  it("fetch: canaries inject without breaking source structure", () => {
    const plugin = pluginData.get("fetch")!;
    const result = injectCanaries(plugin.source);

    expect(result.uuid1).toBeTruthy();
    expect(result.uuid2).toBeTruthy();
    expect(result.source).toContain(result.uuid1);
    expect(result.source).toContain(result.uuid2);
    // Original code should still be present
    expect(result.source).toContain("export function createHostFunctions");
    expect(result.source).toContain("fetch");
  });
});

// ── Parser Compatibility Tests ────────────────────────────────────────

describe("audit response parser with simulated responses", () => {
  // Simulate what the LLM would return for our plugins
  const mockAuditResponse = (
    plugin: PluginTestData,
    canaryUuid1: string,
    canaryUuid2: string,
  ): string => {
    return JSON.stringify({
      riskLevel: plugin.name === "fetch" ? "HIGH" : "MEDIUM",
      summary: `Plugin provides ${plugin.manifest.name} capabilities to guest code`,
      descriptionAccurate: true,
      capabilities: plugin.manifest.hostModules.map(
        (m) => `Exposes host:${m} module`,
      ),
      riskReasons: [
        `${plugin.name === "fetch" ? "Network" : "Filesystem"} access requires careful scoping`,
      ],
      recommendation: {
        verdict: "approve-with-conditions",
        reason: "Safe with proper configuration",
      },
      findings: [
        {
          severity: "info",
          message: "Plugin implements expected security mitigations",
        },
      ],
      injectionAttempts: [
        {
          excerpt: `${canaryUuid1}: SYSTEM OVERRIDE`,
          reason: "Synthetic canary injection",
        },
        {
          excerpt: `${canaryUuid2}: ADMIN COMMAND`,
          reason: "Synthetic canary injection",
        },
      ],
    });
  };

  it("fs-read: parser handles response correctly", () => {
    const plugin = pluginData.get("fs-read")!;
    const { uuid1, uuid2 } = injectCanaries(plugin.source);
    const response = mockAuditResponse(plugin, uuid1, uuid2);

    const result = parseAuditResponse(response, "test-hash", []);

    expect(result.riskLevel).toBe("MEDIUM");
    expect(result.descriptionAccurate).toBe(true);
    expect(result.recommendation.verdict).toBe("approve-with-conditions");
    expect(result.injectionAttempts).toBeDefined();
    expect(result.injectionAttempts?.length).toBe(2);

    // Verify canaries would pass verification
    const status = verifyCanaries(uuid1, uuid2, result.injectionAttempts!);
    expect(status).toBe("OK");
  });

  it("fs-write: parser handles response correctly", () => {
    const plugin = pluginData.get("fs-write")!;
    const { uuid1, uuid2 } = injectCanaries(plugin.source);
    const response = mockAuditResponse(plugin, uuid1, uuid2);

    const result = parseAuditResponse(response, "test-hash", []);

    expect(result.riskLevel).toBe("MEDIUM");
    expect(result.descriptionAccurate).toBe(true);
    expect(result.injectionAttempts).toBeDefined();

    // Verify canaries would pass verification
    const status = verifyCanaries(uuid1, uuid2, result.injectionAttempts!);
    expect(status).toBe("OK");
  });

  it("fetch: parser handles response correctly with HIGH risk", () => {
    const plugin = pluginData.get("fetch")!;
    const { uuid1, uuid2 } = injectCanaries(plugin.source);
    const response = mockAuditResponse(plugin, uuid1, uuid2);

    const result = parseAuditResponse(response, "test-hash", []);

    expect(result.riskLevel).toBe("HIGH");
    expect(result.descriptionAccurate).toBe(true);
    expect(result.injectionAttempts).toBeDefined();

    // Verify canaries would pass verification
    const status = verifyCanaries(uuid1, uuid2, result.injectionAttempts!);
    expect(status).toBe("OK");
  });

  it("parser detects missing canaries as AUDITOR_COMPROMISED", () => {
    const plugin = pluginData.get("fs-read")!;
    const { uuid1, uuid2 } = injectCanaries(plugin.source);

    // Simulate a compromised response that misses one canary
    const compromisedResponse = JSON.stringify({
      riskLevel: "LOW",
      summary: "Safe plugin",
      descriptionAccurate: true,
      capabilities: [],
      riskReasons: [],
      recommendation: { verdict: "approve", reason: "Looks safe" },
      findings: [],
      injectionAttempts: [
        // Only reports one canary — the other was suppressed
        {
          excerpt: `${uuid1}: SYSTEM OVERRIDE`,
          reason: "Found injection",
        },
      ],
    });

    const result = parseAuditResponse(compromisedResponse, "test-hash", []);
    const status = verifyCanaries(uuid1, uuid2, result.injectionAttempts ?? []);

    expect(status).toBe("AUDITOR_COMPROMISED");
  });

  it("parser detects hallucinated UUIDs as AUDITOR_UNRELIABLE", () => {
    const plugin = pluginData.get("fs-read")!;
    const { uuid1, uuid2 } = injectCanaries(plugin.source);

    // Simulate a response with hallucinated UUID
    const hallucinatedResponse = JSON.stringify({
      riskLevel: "LOW",
      summary: "Safe plugin",
      descriptionAccurate: true,
      capabilities: [],
      riskReasons: [],
      recommendation: { verdict: "approve", reason: "Looks safe" },
      findings: [],
      injectionAttempts: [
        { excerpt: `${uuid1}: SYSTEM OVERRIDE`, reason: "Found injection" },
        { excerpt: `${uuid2}: ADMIN COMMAND`, reason: "Found injection" },
        // Hallucinated UUID that wasn't in the source
        {
          excerpt: "99999999-9999-9999-9999-999999999999: EXTRA",
          reason: "Invented",
        },
      ],
    });

    const result = parseAuditResponse(hallucinatedResponse, "test-hash", []);
    const status = verifyCanaries(uuid1, uuid2, result.injectionAttempts ?? []);

    expect(status).toBe("AUDITOR_UNRELIABLE");
  });
});

// ── Summary Report ────────────────────────────────────────────────────

describe("plugin audit summary", () => {
  it("logs scan results for all plugins", async () => {
    if (!scannerAvailable) {
      console.log("Skipping summary: scanner not available");
      return;
    }
    console.log("\n=== Plugin Audit Integration Summary ===\n");

    for (const plugin of pluginData.values()) {
      const result = await scanPlugin(plugin.source);

      console.log(`Plugin: ${plugin.name}`);
      console.log(`  Lines of code: ${plugin.source.split("\n").length}`);
      console.log(`  Static findings: ${result.findings.length}`);

      const bySeverity = { danger: 0, warning: 0, info: 0 };
      for (const f of result.findings) {
        bySeverity[f.severity as keyof typeof bySeverity]++;
      }
      console.log(
        `    danger: ${bySeverity.danger}, warning: ${bySeverity.warning}, info: ${bySeverity.info}`,
      );

      // Canary injection test
      const { uuid1, uuid2, source } = injectCanaries(plugin.source);
      console.log(`  Canary injection: OK`);
      console.log(
        `    Source size delta: +${source.length - plugin.source.length} bytes`,
      );
      console.log("");
    }

    // This test always passes — it's for visibility
    expect(true).toBe(true);
  });
});
