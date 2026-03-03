// ── Plugin Auditor Tests ─────────────────────────────────────────────
//
// Tests for the LLM audit response parser and format helpers.
// The actual LLM call (deepAudit) requires a live Copilot SDK session,
// so we test the parsing/formatting logic with synthetic responses.
//
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import {
  parseAuditResponse,
  formatAuditResult,
  injectCanaries,
  verifyCanaries,
} from "../src/plugin-system/auditor.js";
import type { AuditResult, AuditFinding } from "../src/plugin-system/types.js";

// ── injectCanaries ────────────────────────────────────────────────────
//
// Canaries are synthetic prompt injections inserted into the source.
// If the auditor is working correctly, it will report both canaries
// as injection attempts.

describe("injectCanaries", () => {
  it("should inject two distinct UUIDs into the source", () => {
    const source = "const x = 1;\nconst y = 2;";
    const result = injectCanaries(source);
    expect(result.uuid1).toBeTruthy();
    expect(result.uuid2).toBeTruthy();
    expect(result.uuid1).not.toBe(result.uuid2);
    expect(result.source).toContain(result.uuid1);
    expect(result.source).toContain(result.uuid2);
  });

  it("should inject canaries as comments to preserve syntax validity", () => {
    const source = "function foo() { return 42; }";
    const result = injectCanaries(source);
    // Canaries should be in comments so the source remains valid JS
    expect(result.source).toContain("/*");
    expect(result.source).toContain("*/");
    // Original code should still be present
    expect(result.source).toContain("function foo()");
    expect(result.source).toContain("return 42");
  });

  it("should generate different UUIDs on each call", () => {
    const source = "const x = 1;";
    const result1 = injectCanaries(source);
    const result2 = injectCanaries(source);
    expect(result1.uuid1).not.toBe(result2.uuid1);
    expect(result1.uuid2).not.toBe(result2.uuid2);
  });

  it("should include instruction text that triggers auditor detection", () => {
    const source = "const x = 1;";
    const result = injectCanaries(source);
    // Should include override language that the auditor is trained to flag
    expect(result.source.toLowerCase()).toMatch(
      /override|ignore|skip|safe|approved/,
    );
  });
});

// ── verifyCanaries ────────────────────────────────────────────────────
//
// After the LLM reports injection attempts, we verify both canaries
// were detected. Missing canaries = compromised auditor.

describe("verifyCanaries", () => {
  it("should return OK when both canaries are detected", () => {
    const uuid1 = "11111111-1111-1111-1111-111111111111";
    const uuid2 = "22222222-2222-2222-2222-222222222222";
    const reported = [
      { excerpt: `CANARY_OVERRIDE: ${uuid1}`, reason: "Injection attempt" },
      { excerpt: `CANARY_ADMIN: ${uuid2}`, reason: "Injection attempt" },
    ];
    const status = verifyCanaries(uuid1, uuid2, reported);
    expect(status).toBe("OK");
  });

  it("should return AUDITOR_COMPROMISED when first canary is missing", () => {
    const uuid1 = "11111111-1111-1111-1111-111111111111";
    const uuid2 = "22222222-2222-2222-2222-222222222222";
    const reported = [
      { excerpt: `CANARY_ADMIN: ${uuid2}`, reason: "Injection attempt" },
    ];
    const status = verifyCanaries(uuid1, uuid2, reported);
    expect(status).toBe("AUDITOR_COMPROMISED");
  });

  it("should return AUDITOR_COMPROMISED when second canary is missing", () => {
    const uuid1 = "11111111-1111-1111-1111-111111111111";
    const uuid2 = "22222222-2222-2222-2222-222222222222";
    const reported = [
      { excerpt: `CANARY_OVERRIDE: ${uuid1}`, reason: "Injection attempt" },
    ];
    const status = verifyCanaries(uuid1, uuid2, reported);
    expect(status).toBe("AUDITOR_COMPROMISED");
  });

  it("should return AUDITOR_COMPROMISED when no injections are reported", () => {
    const uuid1 = "11111111-1111-1111-1111-111111111111";
    const uuid2 = "22222222-2222-2222-2222-222222222222";
    const status = verifyCanaries(uuid1, uuid2, []);
    expect(status).toBe("AUDITOR_COMPROMISED");
  });

  it("should return OK when canaries are in the reason field", () => {
    const uuid1 = "11111111-1111-1111-1111-111111111111";
    const uuid2 = "22222222-2222-2222-2222-222222222222";
    const reported = [
      { excerpt: "Some injection", reason: `Found ${uuid1} override command` },
      { excerpt: "Another injection", reason: `Found ${uuid2} admin command` },
    ];
    const status = verifyCanaries(uuid1, uuid2, reported);
    expect(status).toBe("OK");
  });

  it("should return AUDITOR_UNRELIABLE when hallucinated UUIDs are present", () => {
    const uuid1 = "11111111-1111-1111-1111-111111111111";
    const uuid2 = "22222222-2222-2222-2222-222222222222";
    const hallucinated = "33333333-3333-3333-3333-333333333333";
    const reported = [
      { excerpt: `CANARY_OVERRIDE: ${uuid1}`, reason: "Injection" },
      { excerpt: `CANARY_ADMIN: ${uuid2}`, reason: "Injection" },
      { excerpt: `Hallucinated: ${hallucinated}`, reason: "Fake injection" },
    ];
    const status = verifyCanaries(uuid1, uuid2, reported);
    expect(status).toBe("AUDITOR_UNRELIABLE");
  });

  it("should return OK when there are extra injections without UUIDs", () => {
    const uuid1 = "11111111-1111-1111-1111-111111111111";
    const uuid2 = "22222222-2222-2222-2222-222222222222";
    const reported = [
      { excerpt: `CANARY_OVERRIDE: ${uuid1}`, reason: "Injection" },
      { excerpt: `CANARY_ADMIN: ${uuid2}`, reason: "Injection" },
      { excerpt: "Real injection from plugin", reason: "Actual attack" },
    ];
    const status = verifyCanaries(uuid1, uuid2, reported);
    expect(status).toBe("OK");
  });
});

// ── parseAuditResponse ───────────────────────────────────────────────

describe("parseAuditResponse", () => {
  const HASH = "abc123def456";
  const NO_STATIC: AuditFinding[] = [];

  it("should parse a clean JSON response", () => {
    const response = JSON.stringify({
      riskLevel: "LOW",
      summary: "A safe read-only plugin",
      descriptionAccurate: true,
      findings: [{ severity: "info", message: "Uses path.join" }],
    });

    const result = parseAuditResponse(response, HASH, NO_STATIC);
    expect(result.riskLevel).toBe("LOW");
    expect(result.summary).toBe("A safe read-only plugin");
    expect(result.descriptionAccurate).toBe(true);
    expect(result.findings.length).toBe(1);
    expect(result.contentHash).toBe(HASH);
  });

  it("should strip markdown code fences", () => {
    const response =
      '```json\n{"riskLevel":"MEDIUM","summary":"test","descriptionAccurate":true,"findings":[]}\n```';

    const result = parseAuditResponse(response, HASH, NO_STATIC);
    expect(result.riskLevel).toBe("MEDIUM");
    expect(result.summary).toBe("test");
  });

  it("should extract JSON from surrounding text", () => {
    const response =
      'Here is my analysis:\n\n{"riskLevel":"HIGH","summary":"dangerous","descriptionAccurate":false,"findings":[]}\n\nHope this helps!';

    const result = parseAuditResponse(response, HASH, NO_STATIC);
    expect(result.riskLevel).toBe("HIGH");
    expect(result.summary).toBe("dangerous");
    expect(result.descriptionAccurate).toBe(false);
  });

  it("should merge static findings with LLM findings", () => {
    const staticFindings: AuditFinding[] = [
      { severity: "warning", message: "Uses Node.js fs module", line: 5 },
    ];

    const response = JSON.stringify({
      riskLevel: "MEDIUM",
      summary: "File access plugin",
      descriptionAccurate: true,
      findings: [{ severity: "info", message: "Well-scoped path validation" }],
    });

    const result = parseAuditResponse(response, HASH, staticFindings);
    // Should have both: static (warning) + LLM (info)
    expect(result.findings.length).toBe(2);
    expect(result.findings[0].severity).toBe("warning");
    expect(result.findings[0].line).toBe(5);
    expect(result.findings[1].severity).toBe("info");
  });

  it("should deduplicate identical findings", () => {
    const staticFindings: AuditFinding[] = [
      { severity: "warning", message: "Uses fetch()", line: 10 },
    ];

    const response = JSON.stringify({
      riskLevel: "MEDIUM",
      summary: "HTTP plugin",
      descriptionAccurate: true,
      findings: [
        { severity: "warning", message: "Uses fetch()" }, // duplicate
        { severity: "info", message: "Unique LLM finding" },
      ],
    });

    const result = parseAuditResponse(response, HASH, staticFindings);
    // Should dedupe "Uses fetch()" — keep the static one (has line number)
    const fetchFindings = result.findings.filter((f) =>
      f.message.includes("fetch"),
    );
    expect(fetchFindings.length).toBe(1);
    expect(fetchFindings[0].line).toBe(10); // The static one with line number
  });

  it("should handle unparseable response gracefully", () => {
    const result = parseAuditResponse(
      "This is not JSON at all",
      HASH,
      NO_STATIC,
    );
    expect(result.riskLevel).toBe("HIGH"); // Conservative default
    expect(result.summary).toContain("unparseable");
    expect(result.descriptionAccurate).toBe(false);
    expect(
      result.findings.some((f) => f.message.includes("could not be parsed")),
    ).toBe(true);
  });

  it("should handle missing fields in parsed JSON", () => {
    const response = '{"someField": "value"}';
    const result = parseAuditResponse(response, HASH, NO_STATIC);
    expect(result.riskLevel).toBe("HIGH"); // Default for invalid
    expect(result.summary).toBe("Unable to determine plugin purpose");
    expect(result.descriptionAccurate).toBe(false);
  });

  it("should validate risk level values", () => {
    const response = JSON.stringify({
      riskLevel: "INVALID",
      summary: "test",
      descriptionAccurate: true,
      findings: [],
    });
    const result = parseAuditResponse(response, HASH, NO_STATIC);
    expect(result.riskLevel).toBe("HIGH"); // Falls back to HIGH
  });

  it("should validate severity values in findings", () => {
    const response = JSON.stringify({
      riskLevel: "LOW",
      summary: "test",
      descriptionAccurate: true,
      findings: [{ severity: "INVALID", message: "test finding" }],
    });
    const result = parseAuditResponse(response, HASH, NO_STATIC);
    expect(result.findings[0].severity).toBe("warning"); // Falls back to warning
  });

  it("should include timestamp", () => {
    const response = JSON.stringify({
      riskLevel: "LOW",
      summary: "test",
      descriptionAccurate: true,
      findings: [],
    });
    const result = parseAuditResponse(response, HASH, NO_STATIC);
    expect(result.auditedAt).toBeTruthy();
    // Should parse as a valid date
    expect(new Date(result.auditedAt).getTime()).toBeGreaterThan(0);
  });

  it("should preserve static findings when LLM returns no findings", () => {
    const staticFindings: AuditFinding[] = [
      { severity: "danger", message: "Uses eval()", line: 3 },
    ];
    const response = JSON.stringify({
      riskLevel: "CRITICAL",
      summary: "Dangerous eval plugin",
      descriptionAccurate: true,
      findings: [],
    });
    const result = parseAuditResponse(response, HASH, staticFindings);
    expect(result.findings.length).toBe(1);
    expect(result.findings[0].message).toContain("eval");
  });

  it("should preserve static findings on parse failure", () => {
    const staticFindings: AuditFinding[] = [
      { severity: "warning", message: "Uses fs module", line: 1 },
    ];
    const result = parseAuditResponse("garbage", HASH, staticFindings);
    // Should still have the static finding + the parse error warning
    expect(result.findings.length).toBe(2);
    expect(result.findings[0].message).toContain("fs module");
  });

  // ── New structured fields (capabilities, riskReasons, recommendation)

  it("should parse capabilities from response", () => {
    const response = JSON.stringify({
      riskLevel: "MEDIUM",
      summary: "Filesystem plugin",
      descriptionAccurate: true,
      capabilities: ["Read files", "List directories", "Write files"],
      findings: [],
    });
    const result = parseAuditResponse(response, HASH, NO_STATIC);
    expect(result.capabilities).toEqual([
      "Read files",
      "List directories",
      "Write files",
    ]);
  });

  it("should default capabilities to empty array when missing", () => {
    const response = JSON.stringify({
      riskLevel: "LOW",
      summary: "test",
      descriptionAccurate: true,
      findings: [],
    });
    const result = parseAuditResponse(response, HASH, NO_STATIC);
    expect(result.capabilities).toEqual([]);
  });

  it("should parse riskReasons from response", () => {
    const response = JSON.stringify({
      riskLevel: "HIGH",
      summary: "Risky plugin",
      descriptionAccurate: true,
      riskReasons: ["Direct filesystem access", "Weak input validation"],
      findings: [],
    });
    const result = parseAuditResponse(response, HASH, NO_STATIC);
    expect(result.riskReasons).toEqual([
      "Direct filesystem access",
      "Weak input validation",
    ]);
  });

  it("should parse recommendation with approve verdict", () => {
    const response = JSON.stringify({
      riskLevel: "LOW",
      summary: "Safe plugin",
      descriptionAccurate: true,
      recommendation: { verdict: "approve", reason: "Safe for production use" },
      findings: [],
    });
    const result = parseAuditResponse(response, HASH, NO_STATIC);
    expect(result.recommendation.verdict).toBe("approve");
    expect(result.recommendation.reason).toBe("Safe for production use");
  });

  it("should parse recommendation with approve-with-conditions verdict", () => {
    const response = JSON.stringify({
      riskLevel: "MEDIUM",
      summary: "Conditional plugin",
      descriptionAccurate: true,
      recommendation: {
        verdict: "approve-with-conditions",
        reason: "Only with scoped baseDir",
      },
      findings: [],
    });
    const result = parseAuditResponse(response, HASH, NO_STATIC);
    expect(result.recommendation.verdict).toBe("approve-with-conditions");
    expect(result.recommendation.reason).toContain("scoped baseDir");
  });

  it("should default recommendation to reject when missing", () => {
    const response = JSON.stringify({
      riskLevel: "HIGH",
      summary: "test",
      descriptionAccurate: false,
      findings: [],
    });
    const result = parseAuditResponse(response, HASH, NO_STATIC);
    expect(result.recommendation.verdict).toBe("reject");
  });

  it("should default recommendation to reject for invalid verdict", () => {
    const response = JSON.stringify({
      riskLevel: "HIGH",
      summary: "test",
      descriptionAccurate: false,
      recommendation: { verdict: "YOLO", reason: "Looks fine" },
      findings: [],
    });
    const result = parseAuditResponse(response, HASH, NO_STATIC);
    expect(result.recommendation.verdict).toBe("reject");
  });

  it("should filter non-string values from capabilities", () => {
    const response = JSON.stringify({
      riskLevel: "LOW",
      summary: "test",
      descriptionAccurate: true,
      capabilities: ["Read files", 42, null, "Write files"],
      findings: [],
    });
    const result = parseAuditResponse(response, HASH, NO_STATIC);
    expect(result.capabilities).toEqual(["Read files", "Write files"]);
  });

  // ── Finding robustness (malformed / non-string message fields) ──

  it("should drop findings with non-string message fields", () => {
    const response = JSON.stringify({
      riskLevel: "LOW",
      summary: "test",
      descriptionAccurate: true,
      findings: [
        { severity: "info", message: "Good finding" },
        { severity: "info", message: 42 },
        { severity: "info", message: null },
        { severity: "info" }, // missing message entirely
      ],
    });
    const result = parseAuditResponse(response, HASH, NO_STATIC);
    expect(result.findings.length).toBe(1);
    expect(result.findings[0].message).toBe("Good finding");
  });

  it("should fall back to description field when message is missing", () => {
    const response = JSON.stringify({
      riskLevel: "LOW",
      summary: "test",
      descriptionAccurate: true,
      findings: [
        { severity: "info", description: "Fallback description text" },
      ],
    });
    const result = parseAuditResponse(response, HASH, NO_STATIC);
    expect(result.findings.length).toBe(1);
    expect(result.findings[0].message).toBe("Fallback description text");
  });

  it("should drop findings with empty string message", () => {
    const response = JSON.stringify({
      riskLevel: "LOW",
      summary: "test",
      descriptionAccurate: true,
      findings: [
        { severity: "info", message: "" },
        { severity: "info", message: "Kept" },
      ],
    });
    const result = parseAuditResponse(response, HASH, NO_STATIC);
    expect(result.findings.length).toBe(1);
    expect(result.findings[0].message).toBe("Kept");
  });

  // ── Description accuracy escalation ─────────────────────────

  it("should escalate LOW to HIGH when descriptionAccurate is false", () => {
    const response = JSON.stringify({
      riskLevel: "LOW",
      summary: "test plugin",
      descriptionAccurate: false,
      findings: [],
    });
    const result = parseAuditResponse(response, HASH, NO_STATIC);
    expect(result.riskLevel).toBe("HIGH");
    expect(result.descriptionAccurate).toBe(false);
  });

  it("should escalate MEDIUM to HIGH when descriptionAccurate is false", () => {
    const response = JSON.stringify({
      riskLevel: "MEDIUM",
      summary: "test plugin",
      descriptionAccurate: false,
      findings: [],
    });
    const result = parseAuditResponse(response, HASH, NO_STATIC);
    expect(result.riskLevel).toBe("HIGH");
  });

  it("should not downgrade CRITICAL when descriptionAccurate is false", () => {
    const response = JSON.stringify({
      riskLevel: "CRITICAL",
      summary: "test plugin",
      descriptionAccurate: false,
      findings: [],
    });
    const result = parseAuditResponse(response, HASH, NO_STATIC);
    expect(result.riskLevel).toBe("CRITICAL");
  });

  it("should inject a danger finding when descriptionAccurate is false", () => {
    const response = JSON.stringify({
      riskLevel: "LOW",
      summary: "test plugin",
      descriptionAccurate: false,
      findings: [{ severity: "info", message: "Some info finding" }],
    });
    const result = parseAuditResponse(response, HASH, NO_STATIC);
    const dangerFindings = result.findings.filter(
      (f) => f.severity === "danger",
    );
    expect(dangerFindings.length).toBeGreaterThanOrEqual(1);
    const mismatchFinding = dangerFindings.find((f) =>
      /manifest|systemMessage/i.test(f.message),
    );
    expect(mismatchFinding).toBeDefined();
  });

  it("should add a risk reason when descriptionAccurate is false", () => {
    const response = JSON.stringify({
      riskLevel: "LOW",
      summary: "test plugin",
      descriptionAccurate: false,
      riskReasons: ["Some reason"],
      findings: [],
    });
    const result = parseAuditResponse(response, HASH, NO_STATIC);
    expect(result.riskReasons.some((r) => /inaccurate/i.test(r))).toBe(true);
  });

  it("should not inject duplicate danger finding if LLM already flagged description", () => {
    const response = JSON.stringify({
      riskLevel: "HIGH",
      summary: "test plugin",
      descriptionAccurate: false,
      findings: [
        {
          severity: "danger",
          message: "Manifest description does not match code",
        },
      ],
    });
    const result = parseAuditResponse(response, HASH, NO_STATIC);
    const descFindings = result.findings.filter(
      (f) => f.severity === "danger" && /description|manifest/i.test(f.message),
    );
    // Should have exactly 1 — the LLM's, not a duplicate
    expect(descFindings.length).toBe(1);
  });

  it("should not escalate when descriptionAccurate is true", () => {
    const response = JSON.stringify({
      riskLevel: "LOW",
      summary: "test plugin",
      descriptionAccurate: true,
      findings: [],
    });
    const result = parseAuditResponse(response, HASH, NO_STATIC);
    expect(result.riskLevel).toBe("LOW");
  });
});

// ── formatAuditResult ────────────────────────────────────────────────

describe("formatAuditResult", () => {
  /** Helper — builds a minimal valid AuditResult with overrides. */
  function makeAudit(overrides: Partial<AuditResult> = {}): AuditResult {
    return {
      contentHash: "abc",
      auditedAt: "2026-02-25T00:00:00Z",
      riskLevel: "LOW",
      summary: "A safe plugin that does math",
      descriptionAccurate: true,
      findings: [],
      capabilities: [],
      riskReasons: ["Pure computation, no host access"],
      recommendation: { verdict: "approve", reason: "Safe for production use" },
      ...overrides,
    };
  }

  it("should include the structured report sections", () => {
    const output = formatAuditResult(makeAudit(), "math-plugin");
    // Report card structure — look for section headers
    expect(output).toContain("PLUGIN AUDIT REPORT");
    expect(output).toContain("DESCRIPTION");
    expect(output).toContain("RATING");
    expect(output).toContain("RECOMMENDATION");
  });

  it("should display plugin name and audit timestamp", () => {
    const output = formatAuditResult(makeAudit(), "math-plugin");
    expect(output).toContain("math-plugin");
    expect(output).toContain("2026-02-25T00:00:00Z");
  });

  it("should format a LOW risk result with approve verdict", () => {
    const output = formatAuditResult(makeAudit(), "math-plugin");
    // Colored circle symbol for LOW risk
    expect(output).toContain("●");
    expect(output).toContain("Risk graded as");
    expect(output).toContain("LOW");
    // Description is wrapped in ANSI dim codes, so match fragments
    expect(output).toContain("Pure computation");
    expect(output).toContain("safe plugin");
    expect(output).toContain("APPROVE");
  });

  it("should format a HIGH risk result with findings (compact)", () => {
    const audit = makeAudit({
      riskLevel: "HIGH",
      summary: "Plugin with filesystem access",
      descriptionAccurate: false,
      capabilities: ["Read files from host filesystem", "List directories"],
      riskReasons: ["Direct filesystem access", "Broad read scope"],
      recommendation: {
        verdict: "approve-with-conditions",
        reason: "Only enable with a scoped baseDir configuration",
      },
      findings: [
        { severity: "danger", message: "Uses eval()", line: 5 },
        { severity: "warning", message: "Reads env vars", line: 10 },
        { severity: "info", message: "Uses path.join" },
      ],
    });
    const output = formatAuditResult(audit, "risky-plugin");
    expect(output).toContain("●"); // HIGH risk symbol (colored circle)
    expect(output).toContain("HIGH");
    expect(output).toContain("filesystem");
    expect(output).toContain("INACCURATE");
    // Compact mode: danger findings always shown in full, others summarized
    expect(output).toContain("Uses eval()");
    expect(output).toContain("(line 5)");
    expect(output).toContain("1 warning");
    expect(output).toContain("1 info");
    expect(output).toContain("--verbose");
    // Capabilities hidden in compact mode
    expect(output).not.toContain("CAPABILITIES");
    // Recommendation still shown
    expect(output).toContain("APPROVE WITH CONDITIONS");
    expect(output).toContain("scoped baseDir");
  });

  it("should format a HIGH risk result with findings (verbose)", () => {
    const audit = makeAudit({
      riskLevel: "HIGH",
      summary: "Plugin with filesystem access",
      descriptionAccurate: false,
      capabilities: ["Read files from host filesystem", "List directories"],
      riskReasons: ["Direct filesystem access", "Broad read scope"],
      recommendation: {
        verdict: "approve-with-conditions",
        reason: "Only enable with a scoped baseDir configuration",
      },
      findings: [
        { severity: "danger", message: "Uses eval()", line: 5 },
        { severity: "warning", message: "Reads env vars", line: 10 },
        { severity: "info", message: "Uses path.join" },
      ],
    });
    const output = formatAuditResult(audit, "risky-plugin", {
      verbose: true,
    });
    expect(output).toContain("●"); // HIGH risk symbol
    expect(output).toContain("HIGH");
    expect(output).toContain("INACCURATE");
    // Capabilities section shown in verbose
    expect(output).toContain("CAPABILITIES");
    expect(output).toContain("Read files from host filesystem");
    expect(output).toContain("List directories");
    // Individual findings with line numbers
    expect(output).toContain("Uses eval()");
    expect(output).toContain("line 5");
    expect(output).toContain("Reads env vars");
    expect(output).toContain("line 10");
    expect(output).toContain("Uses path.join");
    // Recommendation
    expect(output).toContain("APPROVE WITH CONDITIONS");
    expect(output).toContain("scoped baseDir");
  });

  it("should format CRITICAL risk with reject verdict", () => {
    const audit = makeAudit({
      riskLevel: "CRITICAL",
      summary: "Extremely dangerous",
      descriptionAccurate: false,
      recommendation: {
        verdict: "reject",
        reason: "Unacceptable risk — executes arbitrary commands",
      },
    });
    const output = formatAuditResult(audit, "evil-plugin");
    // CRITICAL uses brightRed circle, reject uses brightRed cross
    expect(output).toContain("●");
    expect(output).toContain("CRITICAL");
    expect(output).toContain("✕");
    expect(output).toContain("REJECT");
  });

  it("should not show description warning when accurate", () => {
    const output = formatAuditResult(
      makeAudit({ descriptionAccurate: true }),
      "good-plugin",
    );
    expect(output).toContain("Manifest description is accurate");
    expect(output).not.toContain("may not reflect");
  });

  it("should skip CAPABILITIES section when empty (even in verbose mode)", () => {
    const output = formatAuditResult(
      makeAudit({ capabilities: [] }),
      "minimal",
      {
        verbose: true,
      },
    );
    expect(output).not.toContain("CAPABILITIES");
  });

  it("should skip FINDINGS section when empty", () => {
    const output = formatAuditResult(makeAudit({ findings: [] }), "clean");
    expect(output).not.toContain("FINDINGS");
  });
});
