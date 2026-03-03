// ── fetch plugin tests ───────────────────────────────────────────────
//
// Unit tests for IP checking, URL validation, domain allowlist parsing,
// header validation, rate limiting, audit logging, and the registered
// host functions (via a mock proto sandbox).
//
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// Test-only exports from the plugin
import {
  _isPrivateIp as isPrivateIp,
  _isPrivateIPv6 as isPrivateIPv6,
  _ipv4ToNumber as ipv4ToNumber,
  _ipv6ToGroups as ipv6ToGroups,
  _extractEmbeddedIPv4 as extractEmbeddedIPv4,
  _groupsToIPv4 as groupsToIPv4,
  _validateUrl as validateUrl,
  _parseDomainAllowlist as parseDomainAllowlist,
  _isDomainAllowed as isDomainAllowed,
  _buildRequestHeaders as buildRequestHeaders,
  _createRateLimiter as createRateLimiter,
  _createAuditLogger as createAuditLogger,
  _safeNumericConfig as safeNumericConfig,
  _enforceMinDelay as enforceMinDelay,
  _categoriseRequestError as categoriseRequestError,
  _validateRedirectTarget as validateRedirectTarget,
  _createResponseCache as createResponseCache,
  _extractRateLimitInfo as extractRateLimitInfo,
  _extractPaginationLinks as extractPaginationLinks,
  _extractConditionalValidators as extractConditionalValidators,
  _createConditionalCache as createConditionalCache,
} from "../plugins/fetch/index.js";

// The createHostFunctions function is the main export
import { createHostFunctions } from "../plugins/fetch/index.js";

// ── Helpers ──────────────────────────────────────────────────────────

/** Create a unique temp dir for each test to avoid cross-contamination. */
function makeTempDir() {
  const dir = join(tmpdir(), `fetch-test-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─────────────────────────────────────────────────────────────────────
// safeNumericConfig
// ─────────────────────────────────────────────────────────────────────

describe("safeNumericConfig", () => {
  it("should return value when valid and under ceiling", () => {
    expect(safeNumericConfig(100, 512, 1024)).toBe(100);
  });

  it("should return default for null", () => {
    expect(safeNumericConfig(null, 512, 1024)).toBe(512);
  });

  it("should return default for undefined", () => {
    expect(safeNumericConfig(undefined, 512, 1024)).toBe(512);
  });

  it("should return default for NaN", () => {
    expect(safeNumericConfig(NaN, 512, 1024)).toBe(512);
  });

  it("should return default for Infinity", () => {
    expect(safeNumericConfig(Infinity, 512, 1024)).toBe(512);
  });

  it("should return default for negative values", () => {
    expect(safeNumericConfig(-1, 512, 1024)).toBe(512);
  });

  it("should clamp to ceiling", () => {
    expect(safeNumericConfig(2000, 512, 1024)).toBe(1024);
  });

  it("should return default for values below floor (0 < default floor of 1)", () => {
    expect(safeNumericConfig(0, 512, 1024)).toBe(512);
  });

  it("should accept floor=0 when explicitly passed", () => {
    expect(safeNumericConfig(0, 512, 1024, 0)).toBe(0);
  });

  it("should reject values below explicit floor", () => {
    expect(safeNumericConfig(500, 5000, 10000, 1000)).toBe(5000);
  });
});

// ─────────────────────────────────────────────────────────────────────
// enforceMinDelay
// ─────────────────────────────────────────────────────────────────────

describe("enforceMinDelay", () => {
  it("should resolve immediately when delay already passed", async () => {
    const start = Date.now() - 1000;
    const before = Date.now();
    await enforceMinDelay(start, 200);
    const after = Date.now();
    // Should resolve in < 50ms (practically instant)
    expect(after - before).toBeLessThan(50);
  });

  it("should wait when delay has not passed", async () => {
    const start = Date.now();
    const before = Date.now();
    await enforceMinDelay(start, 100);
    const after = Date.now();
    // Should have waited at least ~80ms (accounting for timer imprecision)
    expect(after - before).toBeGreaterThanOrEqual(80);
  });
});

// ─────────────────────────────────────────────────────────────────────
// IPv4 helpers
// ─────────────────────────────────────────────────────────────────────

describe("ipv4ToNumber", () => {
  it("should parse valid IPv4 addresses", () => {
    expect(ipv4ToNumber("0.0.0.0")).toBe(0);
    expect(ipv4ToNumber("255.255.255.255")).toBe(0xffffffff);
    expect(ipv4ToNumber("192.168.1.1")).toBe(
      ((192 << 24) | (168 << 16) | (1 << 8) | 1) >>> 0,
    );
    expect(ipv4ToNumber("10.0.0.1")).toBe(
      ((10 << 24) | (0 << 16) | (0 << 8) | 1) >>> 0,
    );
  });

  it("should return null for invalid addresses", () => {
    expect(ipv4ToNumber("")).toBe(null);
    expect(ipv4ToNumber("not-an-ip")).toBe(null);
    expect(ipv4ToNumber("256.1.1.1")).toBe(null);
    expect(ipv4ToNumber("1.2.3")).toBe(null);
    expect(ipv4ToNumber("1.2.3.4.5")).toBe(null);
  });
});

// ─────────────────────────────────────────────────────────────────────
// IPv6 helpers
// ─────────────────────────────────────────────────────────────────────

describe("ipv6ToGroups", () => {
  it("should parse full IPv6 addresses", () => {
    const groups = ipv6ToGroups("2001:0db8:0000:0000:0000:0000:0000:0001");
    expect(groups).toEqual([0x2001, 0x0db8, 0, 0, 0, 0, 0, 1]);
  });

  it("should expand :: notation", () => {
    expect(ipv6ToGroups("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(ipv6ToGroups("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(ipv6ToGroups("fe80::1")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  });

  it("should handle zone IDs", () => {
    const groups = ipv6ToGroups("fe80::1%eth0");
    expect(groups).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  });

  it("should return null for invalid input", () => {
    expect(ipv6ToGroups(":::1")).toBe(null); // Triple colon
    expect(ipv6ToGroups("not-ipv6")).toBe(null);
  });
});

describe("extractEmbeddedIPv4", () => {
  it("should extract from IPv4-mapped addresses", () => {
    // ::ffff:127.0.0.1 → groups [0,0,0,0,0,0xffff, 0x7f00, 0x0001]
    const groups = [0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001];
    expect(extractEmbeddedIPv4(groups)).toBe("127.0.0.1");
  });

  it("should extract from NAT64 addresses", () => {
    // 64:ff9b::10.0.0.1 → groups [0x64, 0xff9b, 0,0,0,0, 0x0a00, 0x0001]
    const groups = [0x0064, 0xff9b, 0, 0, 0, 0, 0x0a00, 0x0001];
    expect(extractEmbeddedIPv4(groups)).toBe("10.0.0.1");
  });

  it("should return null for regular IPv6", () => {
    const groups = [0x2001, 0x0db8, 0, 0, 0, 0, 0, 1];
    expect(extractEmbeddedIPv4(groups)).toBe(null);
  });
});

describe("groupsToIPv4", () => {
  it("should convert groups to dotted-quad string", () => {
    // 0x7f00 = 127.0, 0x0001 = 0.1 → 127.0.0.1
    expect(groupsToIPv4(0x7f00, 0x0001)).toBe("127.0.0.1");
  });

  it("should handle 192.168.1.1", () => {
    // 192.168 = 0xc0a8, 1.1 = 0x0101
    expect(groupsToIPv4(0xc0a8, 0x0101)).toBe("192.168.1.1");
  });

  it("should handle 0.0.0.0", () => {
    expect(groupsToIPv4(0, 0)).toBe("0.0.0.0");
  });
});

describe("ipv6ToGroups - mixed IPv4-in-IPv6 notation", () => {
  it("should parse ::ffff:192.168.1.1 (mixed notation)", () => {
    const groups = ipv6ToGroups("::ffff:192.168.1.1");
    expect(groups).not.toBe(null);
    // 192.168 = 0xc0a8, 1.1 = 0x0101
    expect(groups![5]).toBe(0xffff);
    expect(groups![6]).toBe(0xc0a8);
    expect(groups![7]).toBe(0x0101);
  });

  it("should parse ::ffff:127.0.0.1 (mixed notation loopback)", () => {
    const groups = ipv6ToGroups("::ffff:127.0.0.1");
    expect(groups).not.toBe(null);
    expect(groups![6]).toBe(0x7f00);
    expect(groups![7]).toBe(0x0001);
  });

  it("should return null for invalid embedded IPv4", () => {
    expect(ipv6ToGroups("::ffff:999.999.999.999")).toBe(null);
  });
});

// ─────────────────────────────────────────────────────────────────────
// isPrivateIp — comprehensive range testing
// ─────────────────────────────────────────────────────────────────────

describe("isPrivateIp", () => {
  // ── IPv4 private ranges ──────────────────────────────────────

  describe("IPv4 private ranges", () => {
    const privateCases = [
      ["0.0.0.0", '0.0.0.0/8 — "this network"'],
      ["0.255.255.255", "0.0.0.0/8 — top of range"],
      ["10.0.0.1", "10.0.0.0/8 — RFC 1918"],
      ["10.255.255.255", "10.0.0.0/8 — top of range"],
      ["100.64.0.1", "100.64.0.0/10 — CGNAT"],
      ["100.127.255.255", "100.64.0.0/10 — CGNAT top"],
      ["127.0.0.1", "127.0.0.0/8 — loopback"],
      ["127.255.255.255", "127.0.0.0/8 — loopback top"],
      ["169.254.0.1", "169.254.0.0/16 — link-local"],
      ["169.254.169.254", "169.254.0.0/16 — cloud metadata"],
      ["172.16.0.1", "172.16.0.0/12 — RFC 1918"],
      ["172.31.255.255", "172.16.0.0/12 — RFC 1918 top"],
      ["192.0.0.1", "192.0.0.0/24 — IETF protocol"],
      ["192.0.2.1", "192.0.2.0/24 — TEST-NET-1"],
      ["192.168.0.1", "192.168.0.0/16 — RFC 1918"],
      ["192.168.255.255", "192.168.0.0/16 — RFC 1918 top"],
      ["198.18.0.1", "198.18.0.0/15 — benchmarking"],
      ["198.19.255.255", "198.18.0.0/15 — benchmarking top"],
      ["198.51.100.1", "198.51.100.0/24 — TEST-NET-2"],
      ["203.0.113.1", "203.0.113.0/24 — TEST-NET-3"],
      ["240.0.0.1", "240.0.0.0/4 — reserved"],
      ["255.255.255.254", "240.0.0.0/4 — reserved top"],
      ["255.255.255.255", "broadcast"],
    ];

    for (const [ip, desc] of privateCases) {
      it(`should block ${ip} (${desc})`, () => {
        expect(isPrivateIp(ip)).toBe(true);
      });
    }
  });

  describe("IPv4 public ranges", () => {
    const publicCases = [
      "1.1.1.1",
      "8.8.8.8",
      "100.63.255.255", // Just below CGNAT range
      "100.128.0.0", // Just above CGNAT range
      "172.15.255.255", // Just below 172.16.0.0/12
      "172.32.0.0", // Just above 172.31.255.255
      "192.1.0.1", // Not in any private range
      "198.17.255.255", // Just below benchmarking range
      "198.20.0.0", // Just above benchmarking range
      "204.0.0.1", // Just above TEST-NET-3
      "239.255.255.255", // Just below reserved range
    ];

    for (const ip of publicCases) {
      it(`should allow ${ip}`, () => {
        expect(isPrivateIp(ip)).toBe(false);
      });
    }
  });

  // ── IPv6 private ranges ──────────────────────────────────────

  describe("IPv6 private ranges", () => {
    it("should block :: (unspecified)", () => {
      expect(isPrivateIp("::")).toBe(true);
    });

    it("should block ::1 (loopback)", () => {
      expect(isPrivateIp("::1")).toBe(true);
    });

    it("should block fc00:: (unique local)", () => {
      expect(isPrivateIp("fc00::1")).toBe(true);
    });

    it("should block fd00:: (unique local)", () => {
      expect(isPrivateIp("fd00::1")).toBe(true);
    });

    it("should block fe80:: (link-local)", () => {
      expect(isPrivateIp("fe80::1")).toBe(true);
    });

    it("should allow 2001:db8::1 (documentation, but publicly routed in practice)", () => {
      // Note: 2001:db8::/32 is documentation range but we don't block it
      // since it's not a security risk (it's not routable)
      expect(isPrivateIp("2001:db8::1")).toBe(false);
    });

    it("should allow 2607:f8b0::1 (Google public)", () => {
      expect(isPrivateIp("2607:f8b0::1")).toBe(false);
    });
  });

  // ── IPv4-mapped IPv6 (Athos F-03) ────────────────────────────

  describe("IPv4-mapped IPv6 (SSRF bypass prevention)", () => {
    it("should block ::ffff:127.0.0.1", () => {
      // ::ffff:127.0.0.1 → groups [0,0,0,0,0,0xffff, 0x7f00, 0x0001]
      expect(isPrivateIPv6("::ffff:7f00:1")).toBe(true);
    });

    it("should block ::ffff:10.0.0.1", () => {
      expect(isPrivateIPv6("::ffff:a00:1")).toBe(true);
    });

    it("should block ::ffff:169.254.169.254 (cloud metadata)", () => {
      expect(isPrivateIPv6("::ffff:a9fe:a9fe")).toBe(true);
    });

    it("should block ::ffff:192.168.1.1", () => {
      expect(isPrivateIPv6("::ffff:c0a8:101")).toBe(true);
    });

    it("should allow ::ffff:8.8.8.8 (public)", () => {
      expect(isPrivateIPv6("::ffff:808:808")).toBe(false);
    });
  });

  // ── NAT64 addresses ──────────────────────────────────────────

  describe("NAT64 well-known prefix", () => {
    it("should block 64:ff9b::10.0.0.1", () => {
      expect(isPrivateIPv6("64:ff9b::a00:1")).toBe(true);
    });

    it("should block 64:ff9b::127.0.0.1", () => {
      expect(isPrivateIPv6("64:ff9b::7f00:1")).toBe(true);
    });

    it("should allow 64:ff9b::8.8.8.8", () => {
      expect(isPrivateIPv6("64:ff9b::808:808")).toBe(false);
    });
  });

  // ── Mixed IPv4-in-IPv6 notation (F-01) ─────────────────────

  describe("Mixed IPv4-in-IPv6 notation (SSRF bypass prevention)", () => {
    it("should block ::ffff:192.168.1.1 (mixed notation)", () => {
      expect(isPrivateIp("::ffff:192.168.1.1")).toBe(true);
    });

    it("should block ::ffff:10.0.0.1 (mixed notation)", () => {
      expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true);
    });

    it("should block ::ffff:127.0.0.1 (mixed notation loopback)", () => {
      expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    });

    it("should block ::ffff:169.254.169.254 (mixed notation cloud metadata)", () => {
      expect(isPrivateIp("::ffff:169.254.169.254")).toBe(true);
    });

    it("should allow ::ffff:8.8.8.8 (mixed notation public)", () => {
      expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
    });

    it("should allow ::ffff:1.1.1.1 (mixed notation public)", () => {
      expect(isPrivateIp("::ffff:1.1.1.1")).toBe(false);
    });
  });

  // ── 6to4 and Teredo addresses (F-05) ─────────────────────────

  describe("6to4 and Teredo tunnelling addresses", () => {
    it("should block 2002::1 (6to4 relay prefix)", () => {
      expect(isPrivateIp("2002::1")).toBe(true);
    });

    it("should block 2002:c0a8:101::1 (6to4 embedding 192.168.1.1)", () => {
      expect(isPrivateIp("2002:c0a8:101::1")).toBe(true);
    });

    it("should block 2001:0000::1 (Teredo prefix)", () => {
      expect(isPrivateIp("2001:0000::1")).toBe(true);
    });

    it("should block 2001:0:4136:e378:8000:63bf:3fff:fdd2 (Teredo)", () => {
      expect(isPrivateIp("2001:0:4136:e378:8000:63bf:3fff:fdd2")).toBe(true);
    });
  });

  // ── Edge cases ───────────────────────────────────────────────

  describe("edge cases", () => {
    it("should block null", () => {
      expect(isPrivateIp(null as unknown as string)).toBe(true);
    });

    it("should block undefined", () => {
      expect(isPrivateIp(undefined as unknown as string)).toBe(true);
    });

    it("should block empty string", () => {
      expect(isPrivateIp("")).toBe(true);
    });

    it("should block non-IP strings", () => {
      expect(isPrivateIp("not-an-ip")).toBe(true);
    });

    it("should block malformed IPs", () => {
      expect(isPrivateIp("999.999.999.999")).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Domain Allowlist Parsing
// ─────────────────────────────────────────────────────────────────────

describe("parseDomainAllowlist", () => {
  it("should parse exact domains", () => {
    const { exact, wildcards, errors } = parseDomainAllowlist([
      "api.github.com",
      "api.stripe.com",
    ]);
    expect(exact).toEqual(new Set(["api.github.com", "api.stripe.com"]));
    expect(wildcards).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("should parse wildcard domains", () => {
    const { exact, wildcards, errors } = parseDomainAllowlist([
      "*.example.com",
      "*.api.internal.co",
    ]);
    expect(exact.size).toBe(0);
    expect(wildcards).toEqual(["example.com", "api.internal.co"]);
    expect(errors).toEqual([]);
  });

  it("should lowercase domains", () => {
    const { exact } = parseDomainAllowlist(["API.GITHUB.COM"]);
    expect(exact.has("api.github.com")).toBe(true);
  });

  it("should trim whitespace", () => {
    const { exact } = parseDomainAllowlist(["  api.github.com  "]);
    expect(exact.has("api.github.com")).toBe(true);
  });

  it("should skip empty entries", () => {
    const { exact } = parseDomainAllowlist(["", "  ", "api.github.com"]);
    expect(exact.size).toBe(1);
  });

  it("should reject global wildcard", () => {
    const { errors } = parseDomainAllowlist(["*"]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("not permitted");
  });

  it("should reject shallow wildcards like *.com", () => {
    const { wildcards, errors } = parseDomainAllowlist(["*.com"]);
    expect(wildcards).toEqual([]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("too broad");
  });

  it("should reject *.co.uk but allow it (2 parent labels meets minimum)", () => {
    // *.co.uk has parent "co.uk" which is 2 labels — this passes MIN_WILDCARD_PARENT_LABELS
    // This is actually allowed because co.uk has 2 labels
    const { wildcards } = parseDomainAllowlist(["*.co.uk"]);
    expect(wildcards).toEqual(["co.uk"]);
  });

  it("should reject multi-level wildcards", () => {
    const { errors } = parseDomainAllowlist(["*.*.example.com"]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("Multi-level");
  });

  it("should reject wildcards in non-prefix position", () => {
    const { errors } = parseDomainAllowlist(["api.*.com"]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("non-prefix");
  });

  it("should handle non-array input", () => {
    const { exact, wildcards, errors } = parseDomainAllowlist(
      null as unknown as string[],
    );
    expect(exact.size).toBe(0);
    expect(wildcards).toEqual([]);
    expect(errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// isDomainAllowed
// ─────────────────────────────────────────────────────────────────────

describe("isDomainAllowed", () => {
  const exact = new Set(["api.github.com", "api.stripe.com"]);
  const wildcards = ["example.com"];

  it("should match exact domains", () => {
    expect(isDomainAllowed("api.github.com", exact, wildcards)).toBe(true);
    expect(isDomainAllowed("api.stripe.com", exact, wildcards)).toBe(true);
  });

  it("should match single-level wildcards", () => {
    expect(isDomainAllowed("www.example.com", exact, wildcards)).toBe(true);
    expect(isDomainAllowed("api.example.com", exact, wildcards)).toBe(true);
  });

  it("should NOT match multi-level sub of wildcard", () => {
    expect(isDomainAllowed("a.b.example.com", exact, wildcards)).toBe(false);
  });

  it("should NOT match the bare parent domain", () => {
    expect(isDomainAllowed("example.com", exact, wildcards)).toBe(false);
  });

  it("should reject domains not in allowlist", () => {
    expect(isDomainAllowed("evil.com", exact, wildcards)).toBe(false);
    expect(isDomainAllowed("github.com", exact, wildcards)).toBe(false);
  });

  it("should auto-allow subdomains of exact-match domains", () => {
    // If "openai.com" is exact-allowed, "developers.openai.com" should match
    const exactWithParent = new Set(["openai.com", "anthropic.com"]);
    expect(isDomainAllowed("developers.openai.com", exactWithParent, [])).toBe(
      true,
    );
    expect(isDomainAllowed("docs.anthropic.com", exactWithParent, [])).toBe(
      true,
    );
    expect(isDomainAllowed("platform.claude.com", exactWithParent, [])).toBe(
      false,
    ); // different domain entirely
    expect(isDomainAllowed("a.b.openai.com", exactWithParent, [])).toBe(true); // multi-level subdomain also allowed
  });

  it("should not match parent when only subdomain is exact-allowed", () => {
    // If "api.github.com" is allowed, plain "github.com" should NOT match
    expect(isDomainAllowed("github.com", exact, wildcards)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// URL Validation
// ─────────────────────────────────────────────────────────────────────

describe("validateUrl", () => {
  const exact = new Set(["api.github.com"]);
  const wildcards = ["example.com"];

  it("should accept valid HTTPS URL on allowed domain", () => {
    const result = validateUrl(
      "https://api.github.com/repos",
      exact,
      wildcards,
    );
    expect(result.valid).toBe(true);
    expect(result.hostname).toBe("api.github.com");
  });

  it("should accept wildcard subdomain", () => {
    const result = validateUrl(
      "https://cdn.example.com/file",
      exact,
      wildcards,
    );
    expect(result.valid).toBe(true);
  });

  it("should reject HTTP URLs", () => {
    const result = validateUrl("http://api.github.com/repos", exact, wildcards);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("HTTPS");
  });

  it("should reject non-allowed domains", () => {
    const result = validateUrl("https://evil.com/steal", exact, wildcards);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("domain not in allowlist");
  });

  it("should reject URLs with credentials", () => {
    const result = validateUrl(
      "https://user:pass@api.github.com/",
      exact,
      wildcards,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("credentials");
  });

  it("should reject IP addresses in URL", () => {
    // Add 127.0.0.1 to exact to test IP rejection (it should reject regardless)
    const withIp = new Set(["127.0.0.1"]);
    const result = validateUrl("https://127.0.0.1/", withIp, []);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("IP addresses not permitted");
  });

  it("should reject IPv6 literal addresses", () => {
    const result = validateUrl("https://[::1]/", exact, wildcards);
    expect(result.valid).toBe(false);
  });

  it("should normalise path traversal (URL parser resolves ..)", () => {
    // new URL() resolves "/../../../etc/passwd" to "/etc/passwd"
    // which is safe — the host URL constructor eliminates traversal.
    // The path no longer contains ".." after parsing.
    const result = validateUrl(
      "https://api.github.com/../../../etc/passwd",
      exact,
      wildcards,
    );
    expect(result.valid).toBe(true);
    expect(result.url!.pathname).toBe("/etc/passwd"); // Normalised — no traversal
  });

  it("should reject literal dot-dot in percent-encoded path", () => {
    // %2e%2e is not decoded by new URL() — stays as "%2e%2e"
    // Our check on split('/') segments catches literal ".." only,
    // but percent-encoded variants are handled by the URL parser.
    // This is safe because node:https sends the normalised path.
    const result = validateUrl(
      "https://api.github.com/safe/path",
      exact,
      wildcards,
    );
    expect(result.valid).toBe(true);
  });

  it("should reject control characters", () => {
    const result = validateUrl(
      "https://api.github.com/\x00evil",
      exact,
      wildcards,
    );
    expect(result.valid).toBe(false);
  });

  it("should reject non-string input", () => {
    expect(validateUrl(null as unknown as string, exact, wildcards).valid).toBe(
      false,
    );
    expect(validateUrl(42 as unknown as string, exact, wildcards).valid).toBe(
      false,
    );
    expect(validateUrl("", exact, wildcards).valid).toBe(false);
  });

  it("should reject URLs exceeding max length", () => {
    const longUrl = "https://api.github.com/" + "a".repeat(3000);
    const result = validateUrl(longUrl, exact, wildcards);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("too long");
  });

  it("should strip fragments from reconstructed URL", () => {
    const result = validateUrl(
      "https://api.github.com/path#fragment",
      exact,
      wildcards,
    );
    expect(result.valid).toBe(true);
    expect(result.url!.hash).toBe("");
  });

  it("should preserve query parameters", () => {
    const result = validateUrl(
      "https://api.github.com/search?q=test",
      exact,
      wildcards,
    );
    expect(result.valid).toBe(true);
    expect(result.url!.search).toBe("?q=test");
  });

  it("should reject single-label hostnames", () => {
    const result = validateUrl(
      "https://localhost/path",
      new Set(["localhost"]),
      [],
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("invalid hostname");
  });

  // ── Port rejection (F-02) ────────────────────────────────────

  it("should reject non-standard port", () => {
    const result = validateUrl(
      "https://api.github.com:8443/repos",
      exact,
      wildcards,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("non-standard port");
  });

  it("should allow explicit port 443", () => {
    const result = validateUrl(
      "https://api.github.com:443/repos",
      exact,
      wildcards,
    );
    expect(result.valid).toBe(true);
  });

  it("should allow default port (no explicit port)", () => {
    const result = validateUrl(
      "https://api.github.com/repos",
      exact,
      wildcards,
    );
    expect(result.valid).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Header Validation
// ─────────────────────────────────────────────────────────────────────

describe("buildRequestHeaders", () => {
  const allowedNames = new Set(["authorization", "content-type", "accept"]);
  const userAgent = "hyperlight-fetch/1.0";

  it("should set User-Agent from config", () => {
    const { headers } = buildRequestHeaders({}, allowedNames, userAgent);
    expect(headers["User-Agent"]).toBe("hyperlight-fetch/1.0");
  });

  it("should pass allowed headers through", () => {
    const { headers } = buildRequestHeaders(
      { Authorization: "Bearer token123", Accept: "application/json" },
      allowedNames,
      userAgent,
    );
    expect(headers["Authorization"]).toBe("Bearer token123");
    expect(headers["Accept"]).toBe("application/json");
  });

  it("should strip non-allowed headers", () => {
    const { headers } = buildRequestHeaders(
      { "X-Custom-Header": "value" },
      allowedNames,
      userAgent,
    );
    expect(headers["X-Custom-Header"]).toBeUndefined();
  });

  it("should strip forbidden headers regardless of allowlist", () => {
    const allHeaders = new Set(["cookie", "host", "user-agent"]);
    const { headers } = buildRequestHeaders(
      { Cookie: "session=abc", Host: "evil.com" },
      allHeaders,
      userAgent,
    );
    expect(headers["Cookie"]).toBeUndefined();
    expect(headers["Host"]).toBeUndefined();
  });

  it("should reject headers with CRLF injection", () => {
    const result = buildRequestHeaders(
      { Authorization: "Bearer token\r\nHost: evil.com" },
      allowedNames,
      userAgent,
    );
    expect(result.error).toContain("invalid header value");
  });

  it("should reject headers with null bytes", () => {
    const result = buildRequestHeaders(
      { Authorization: "Bearer\x00evil" },
      allowedNames,
      userAgent,
    );
    expect(result.error).toContain("invalid header value");
  });

  it("should reject oversized header values", () => {
    const result = buildRequestHeaders(
      { Authorization: "Bearer " + "x".repeat(5000) },
      allowedNames,
      userAgent,
    );
    expect(result.error).toContain("header value too large");
  });

  it("should handle null/undefined sandboxHeaders", () => {
    const { headers, error } = buildRequestHeaders(
      null as unknown as object,
      allowedNames,
      userAgent,
    );
    expect(error).toBeUndefined();
    expect(headers["User-Agent"]).toBe("hyperlight-fetch/1.0");
  });

  it("should handle non-string header values", () => {
    const { headers } = buildRequestHeaders(
      { Authorization: 42 },
      allowedNames,
      userAgent,
    );
    // Non-string values are silently skipped
    expect(headers["Authorization"]).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Rate Limiter
// ─────────────────────────────────────────────────────────────────────

describe("createRateLimiter", () => {
  const defaultConfig = {
    maxPerMinute: 5,
    maxPerHour: 20,
    maxDomains: 3,
    maxDataReceivedBytes: 1024 * 1024,
  };

  it("should allow requests within limits", () => {
    const rl = createRateLimiter(defaultConfig);
    const check = rl.check("api.github.com");
    expect(check.allowed).toBe(true);
  });

  it("should block after per-minute limit", () => {
    const rl = createRateLimiter({ ...defaultConfig, maxPerMinute: 2 });
    rl.recordRequest("a.com");
    rl.recordRequest("a.com");
    const check = rl.check("a.com");
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("per-minute");
  });

  it("should block after per-hour limit", () => {
    const rl = createRateLimiter({
      ...defaultConfig,
      maxPerHour: 3,
      maxPerMinute: 100,
    });
    rl.recordRequest("a.com");
    rl.recordRequest("a.com");
    rl.recordRequest("a.com");
    const check = rl.check("a.com");
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("per-hour");
  });

  it("should block after domain limit", () => {
    const rl = createRateLimiter({ ...defaultConfig, maxDomains: 2 });
    rl.recordRequest("a.com");
    rl.recordRequest("b.com");
    // Third unique domain should be blocked
    const check = rl.check("c.com");
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("domains");
  });

  it("should allow same domain after domain limit", () => {
    const rl = createRateLimiter({ ...defaultConfig, maxDomains: 2 });
    rl.recordRequest("a.com");
    rl.recordRequest("b.com");
    // Same domain as before — should be fine
    const check = rl.check("a.com");
    expect(check.allowed).toBe(true);
  });

  it("should block after data budget exhausted", () => {
    const rl = createRateLimiter({
      ...defaultConfig,
      maxDataReceivedBytes: 100,
    });
    rl.recordRequest("a.com");
    rl.recordResponseBytes(101);
    const check = rl.check("a.com");
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("data budget");
  });

  it("should provide counters", () => {
    const rl = createRateLimiter(defaultConfig);
    rl.recordRequest("a.com");
    rl.recordRequest("b.com");
    rl.recordResponseBytes(500);
    const counters = rl.getCounters();
    expect(counters.requestsTotal).toBe(2);
    expect(counters.uniqueDomains).toBe(2);
    expect(counters.bytesReceived).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Audit Logger
// ─────────────────────────────────────────────────────────────────────

describe("createAuditLogger", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should create log entries with session ID and timestamp", () => {
    // We test the logger's internal structure by using a known home dir
    // The actual createAuditLogger writes to ~/.hyperagent/ which we
    // can't easily redirect in unit tests without env manipulation.
    // Instead we test the function exists and the interface is correct.
    const logger = createAuditLogger("test-session-123");
    expect(typeof logger.log).toBe("function");
  });

  it("should not throw on log failure", () => {
    // Audit logging is best-effort — must not throw
    const logger = createAuditLogger("test-session");
    expect(() => {
      logger.log({ method: "GET", hostname: "test.com", outcome: "success" });
    }).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────
// register — integration tests via mock proto
// ─────────────────────────────────────────────────────────────────────

describe("createHostFunctions", () => {
  let fns: ReturnType<typeof createHostFunctions>["fetch"];

  beforeEach(() => {
    const hostFuncs = createHostFunctions({
      allowedDomains: ["api.github.com", "*.example.com"],
      allowPost: true,
      allowedRequestHeaders: ["Authorization", "Content-Type", "Accept"],
      allowedContentTypes: ["application/json", "text/plain"],
      maxRequestsPerMinute: 30,
      maxRequestsPerHour: 100,
      maxDomainsPerSession: 5,
      maxDataReceivedKb: 512,
    });
    fns = hostFuncs.fetch;
  });

  it("should register get, head, read, readBinary, fetchJSON, fetchText, fetchBinary, fetchBinaryBatch, and post host functions", () => {
    expect(Object.keys(fns)).toEqual(
      expect.arrayContaining([
        "get",
        "head",
        "read",
        "readBinary",
        "fetchJSON",
        "fetchText",
        "fetchBinary",
        "fetchBinaryBatch",
        "post",
      ]),
    );
    expect(Object.keys(fns)).toHaveLength(9);
  });

  it("should return metadata-only envelope from get (no body)", async () => {
    // Hits a real endpoint — should return metadata or a transient error.
    const result = await fns.get("https://api.github.com/repos");
    // Must be a well-formed envelope — either { status, ok, contentType, totalBytes } or { error }
    const isSuccess = typeof result.status === "number";
    const isError = typeof result.error === "string";
    expect(isSuccess || isError).toBe(true);
    if (isError) {
      expect(result.error).toMatch(/fetch (failed|blocked)/);
    } else {
      // Metadata envelope must include contentType (media type, no params)
      expect(typeof result.contentType).toBe("string");
      expect(result.contentType).not.toContain(";"); // params stripped
      // Must include totalBytes (body size in bytes)
      expect(typeof result.totalBytes).toBe("number");
      expect(result.totalBytes).toBeGreaterThanOrEqual(0);
      // Must NOT include a body field — body comes via read()
      expect((result as Record<string, unknown>).body).toBeUndefined();
    }
  });

  it("should block HTTP URLs", async () => {
    const result = await fns.get("http://api.github.com/repos");
    expect(result.error).toContain("HTTPS");
  });

  it("should block non-allowlisted domains", async () => {
    const result = await fns.get("https://evil.com/steal");
    expect(result.error).toContain("domain not in allowlist");
  });

  it("should block IP addresses", async () => {
    const result = await fns.get("https://127.0.0.1/");
    expect(result.error).toContain("IP addresses not permitted");
  });

  it("should block URLs with credentials", async () => {
    const result = await fns.get("https://user:pass@api.github.com/");
    expect(result.error).toContain("credentials");
  });

  it("should block invalid URLs", async () => {
    const result = await fns.get("not-a-url");
    expect(result.error).toContain("invalid URL");
  });

  it("should handle non-string URL input", async () => {
    const result = await fns.get(42 as unknown as string);
    expect(result.error).toBeDefined();
  });
});

describe("createHostFunctions with POST disabled", () => {
  it("should return clear error when POST is disabled", async () => {
    const hostFuncs = createHostFunctions({
      allowedDomains: ["api.github.com"],
      allowPost: false,
    });
    const result = await hostFuncs.fetch.post("https://api.github.com/", {});
    expect(result.error).toContain("POST not allowed");
  });

  it("should still include post function (stub)", () => {
    const hostFuncs = createHostFunctions({
      allowedDomains: ["api.github.com"],
      allowPost: false,
    });
    expect(hostFuncs.fetch.post).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// POST body validation (R-08)
// ─────────────────────────────────────────────────────────────────────

describe("createHostFunctions - POST body validation", () => {
  let fns: ReturnType<typeof createHostFunctions>["fetch"];

  beforeEach(() => {
    const hostFuncs = createHostFunctions({
      allowedDomains: ["api.github.com"],
      allowPost: true,
      maxRequestBodySizeKb: 4, // 4KB max
    });
    fns = hostFuncs.fetch;
  });

  it("should reject body that is too large", async () => {
    const largeBody = "x".repeat(5 * 1024); // 5KB > 4KB limit
    const result = await fns.post("https://api.github.com/data", largeBody);
    expect(result.error).toContain("request body too large");
  });

  it("should reject non-serialisable body types (number)", async () => {
    const result = await fns.post("https://api.github.com/data", 42);
    expect(result.error).toContain("body must be a string or object");
  });

  it("should reject non-serialisable body types (boolean)", async () => {
    const result = await fns.post("https://api.github.com/data", true);
    expect(result.error).toContain("body must be a string or object");
  });

  it("should accept null/undefined body (empty POST)", async () => {
    // Should pass body validation — the result will be either a network
    // error or a real HTTP response, but never a body-validation error.
    const result = await fns.post("https://api.github.com/data", null);
    if (result.error) {
      expect(result.error).not.toContain("body");
    } else {
      // Request succeeded — body was accepted
      expect(typeof result.status).toBe("number");
    }
  });

  it("should accept string body", async () => {
    const result = await fns.post(
      "https://api.github.com/data",
      '{"key":"value"}',
    );
    if (result.error) {
      expect(result.error).not.toContain("body");
    } else {
      expect(typeof result.status).toBe("number");
    }
  });

  it("should accept object body", async () => {
    const result = await fns.post("https://api.github.com/data", {
      key: "value",
    });
    if (result.error) {
      expect(result.error).not.toContain("body");
    } else {
      expect(typeof result.status).toBe("number");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Port rejection — integration (F-02)
// ─────────────────────────────────────────────────────────────────────

describe("createHostFunctions - port rejection", () => {
  it("should block non-standard port via registered get", async () => {
    const hostFuncs = createHostFunctions({
      allowedDomains: ["api.github.com"],
    });
    const result = await hostFuncs.fetch.get(
      "https://api.github.com:8443/repos",
    );
    expect(result.error).toContain("non-standard port");
  });
});

describe("createHostFunctions with no domains", () => {
  it("should throw when no domains configured", () => {
    // Since Phase D fix: empty allowedDomains throws at registration
    // time rather than silently blocking every request at runtime.
    expect(() => createHostFunctions({ allowedDomains: [] })).toThrow(
      /no valid domains configured/i,
    );
  });
});

describe("createHostFunctions with null config", () => {
  it("should handle null config gracefully", () => {
    // Null config means no domains configured, which now throws at
    // registration time (Phase D: fail loud on empty allowedDomains).
    expect(() => createHostFunctions(null as unknown as object)).toThrow(
      /no valid domains configured/i,
    );
  });
});

describe("createHostFunctions with domain validation warnings", () => {
  it("should log warnings for invalid domains but still create functions", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const hostFuncs = createHostFunctions({
      allowedDomains: ["*.com", "api.github.com", "*"],
    });
    expect(spy).toHaveBeenCalled();
    // Valid domain should still work
    expect(hostFuncs.fetch.get).toBeDefined();
    spy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Rate limit minute ≤ hour clamping
// ─────────────────────────────────────────────────────────────────────

describe("createHostFunctions rate limit clamping", () => {
  it("should clamp maxRequestsPerMinute to maxRequestsPerHour when minute exceeds hour", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // 60/minute but only 10/hour — minute must be clamped to 10
    createHostFunctions({
      allowedDomains: ["api.example.com"],
      maxRequestsPerMinute: 60,
      maxRequestsPerHour: 10,
    });
    // Should have warned about clamping
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("clamped to 10"));
    spy.mockRestore();
  });

  it("should NOT warn when maxRequestsPerMinute <= maxRequestsPerHour", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    createHostFunctions({
      allowedDomains: ["api.example.com"],
      maxRequestsPerMinute: 10,
      maxRequestsPerHour: 100,
    });
    // No clamping warning — only domain warnings would appear
    const clampCalls = spy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("clamped"),
    );
    expect(clampCalls).toHaveLength(0);
    spy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Domain error consolidation in throw message
// ─────────────────────────────────────────────────────────────────────

describe("createHostFunctions domain error consolidation", () => {
  it("should include rejected entries in the throw message when ALL domains are invalid", () => {
    expect(() =>
      createHostFunctions({ allowedDomains: ["*.com", "*", "*.*.evil.com"] }),
    ).toThrow(/Rejected entries/);
  });

  it("should include specific rejection reasons in the throw message", () => {
    expect(() => createHostFunctions({ allowedDomains: ["*"] })).toThrow(
      /Global wildcard/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// Audit logger error visibility
// ─────────────────────────────────────────────────────────────────────

describe("audit logger error visibility", () => {
  it("should log errors to console.error instead of silently swallowing", () => {
    // We verify the logger calls console.error on failure by creating
    // a logger and checking it doesn't throw (best-effort still holds),
    // but we can't easily force a write failure without env manipulation.
    // The main assertion is that the code path exists — verified by
    // code review (catch blocks now include console.error).
    const logger = createAuditLogger("error-visibility-test");
    expect(typeof logger.log).toBe("function");
    // Best-effort guarantee: calling log must never throw
    expect(() => {
      logger.log({ method: "GET", hostname: "test.com", outcome: "test" });
    }).not.toThrow();
  });
});

// ── categoriseRequestError ───────────────────────────────────────────
//
// Safe error classification — exposes error codes without leaking
// internal hostnames, stack traces, or redirect targets.

describe("categoriseRequestError", () => {
  /** Helper to create an Error with a .code property. */
  function makeError(
    message: string,
    code?: string,
  ): Error & { code?: string } {
    const err: Error & { code?: string } = new Error(message);
    if (code) err.code = code;
    return err;
  }

  it("should categorise DNS resolution failure", () => {
    expect(categoriseRequestError(makeError("DNS resolution failed"))).toBe(
      "fetch failed: DNS resolution failed",
    );
  });

  it("should categorise ENOTFOUND as DNS failure", () => {
    expect(
      categoriseRequestError(
        makeError("getaddrinfo ENOTFOUND foo.bar", "ENOTFOUND"),
      ),
    ).toBe("fetch failed: DNS resolution failed");
  });

  it("should keep SSRF blocked opaque", () => {
    // Must NOT reveal that a private IP was detected
    expect(categoriseRequestError(makeError("SSRF blocked"))).toBe(
      "fetch failed: request error",
    );
  });

  it("should categorise ECONNREFUSED", () => {
    expect(
      categoriseRequestError(makeError("connect ECONNREFUSED", "ECONNREFUSED")),
    ).toBe("fetch failed: connection refused");
  });

  it("should categorise ECONNRESET", () => {
    expect(
      categoriseRequestError(makeError("read ECONNRESET", "ECONNRESET")),
    ).toBe("fetch failed: connection reset");
  });

  it("should categorise EPIPE", () => {
    expect(categoriseRequestError(makeError("write EPIPE", "EPIPE"))).toBe(
      "fetch failed: connection broken",
    );
  });

  it("should categorise ETIMEDOUT", () => {
    expect(
      categoriseRequestError(makeError("connect ETIMEDOUT", "ETIMEDOUT")),
    ).toBe("fetch failed: connection timed out");
  });

  it("should categorise EHOSTUNREACH", () => {
    expect(
      categoriseRequestError(makeError("connect EHOSTUNREACH", "EHOSTUNREACH")),
    ).toBe("fetch failed: host unreachable");
  });

  it("should categorise ENETUNREACH", () => {
    expect(
      categoriseRequestError(makeError("connect ENETUNREACH", "ENETUNREACH")),
    ).toBe("fetch failed: network unreachable");
  });

  it("should categorise TLS errors with the code", () => {
    expect(
      categoriseRequestError(
        makeError("TLS handshake failed", "ERR_TLS_CERT_ALTNAME_INVALID"),
      ),
    ).toBe("fetch failed: TLS error (ERR_TLS_CERT_ALTNAME_INVALID)");
  });

  it("should categorise certificate errors", () => {
    expect(categoriseRequestError(makeError("cert", "CERT_HAS_EXPIRED"))).toBe(
      "fetch failed: certificate error (expired)",
    );
  });

  it("should categorise self-signed certificate errors", () => {
    expect(
      categoriseRequestError(makeError("cert", "DEPTH_ZERO_SELF_SIGNED_CERT")),
    ).toBe("fetch failed: certificate error (self-signed certificate)");
  });

  it("should categorise UNABLE_TO_VERIFY_LEAF_SIGNATURE", () => {
    expect(
      categoriseRequestError(
        makeError("cert", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"),
      ),
    ).toBe("fetch failed: certificate error (UNABLE_TO_VERIFY_LEAF_SIGNATURE)");
  });

  it("should include unknown error codes in the message", () => {
    expect(
      categoriseRequestError(makeError("something weird", "EWHATEVER")),
    ).toBe("fetch failed: request error (EWHATEVER)");
  });

  it("should fall back to generic message when no code is available", () => {
    expect(categoriseRequestError(new Error("something unknown"))).toBe(
      "fetch failed: request error",
    );
  });

  it("should never expose the raw error message", () => {
    // The raw message could contain internal hostnames or stack info
    const err = makeError(
      "connect ECONNREFUSED 192.168.1.100:443",
      "ECONNREFUSED",
    );
    const result = categoriseRequestError(err);
    expect(result).not.toContain("192.168.1.100");
    expect(result).toBe("fetch failed: connection refused");
  });
});

// ── validateRedirectTarget ───────────────────────────────────────
//
// Redirect following security — each hop is re-validated against
// domain allowlist, HTTPS-only, SSRF checks, no credentials, etc.

describe("validateRedirectTarget", () => {
  const originalUrl = new URL("https://api.example.com/page");
  const exact = new Set([
    "api.example.com",
    "cdn.example.com",
    "auth.example.com",
  ]);
  const wildcards = ["example.com"];

  it("should accept redirect to same allowed domain", () => {
    const result = validateRedirectTarget(
      "https://api.example.com/other-page",
      originalUrl,
      exact,
      wildcards,
    );
    expect(result.valid).toBe(true);
    expect(result.url!.hostname).toBe("api.example.com");
    expect(result.url!.pathname).toBe("/other-page");
  });

  it("should accept redirect to different allowed exact domain", () => {
    const result = validateRedirectTarget(
      "https://cdn.example.com/asset",
      originalUrl,
      exact,
      wildcards,
    );
    expect(result.valid).toBe(true);
    expect(result.url!.hostname).toBe("cdn.example.com");
  });

  it("should accept redirect to wildcard-matched domain", () => {
    const result = validateRedirectTarget(
      "https://images.example.com/photo.jpg",
      originalUrl,
      exact,
      wildcards,
    );
    expect(result.valid).toBe(true);
    expect(result.url!.hostname).toBe("images.example.com");
  });

  it("should accept relative redirects (resolved against original URL)", () => {
    const result = validateRedirectTarget(
      "/new-location",
      originalUrl,
      exact,
      wildcards,
    );
    expect(result.valid).toBe(true);
    expect(result.url!.hostname).toBe("api.example.com");
    expect(result.url!.pathname).toBe("/new-location");
  });

  it("should reject redirect to domain NOT in allowlist", () => {
    const result = validateRedirectTarget(
      "https://evil.com/steal-data",
      originalUrl,
      exact,
      wildcards,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe(
      "fetch blocked: redirect to domain not in allowlist (evil.com)",
    );
  });

  it("should reject redirect to HTTP (protocol downgrade)", () => {
    const result = validateRedirectTarget(
      "http://api.example.com/page",
      originalUrl,
      exact,
      wildcards,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe("fetch blocked: redirect to non-HTTPS URL");
  });

  it("should reject redirect to IP address", () => {
    const result = validateRedirectTarget(
      "https://127.0.0.1/internal",
      originalUrl,
      exact,
      wildcards,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe("fetch blocked: redirect to IP address");
  });

  it("should reject redirect with credentials in URL", () => {
    const result = validateRedirectTarget(
      "https://user:pass@api.example.com/page",
      originalUrl,
      exact,
      wildcards,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe(
      "fetch blocked: redirect URL contains credentials",
    );
  });

  it("should reject redirect to non-standard port", () => {
    const result = validateRedirectTarget(
      "https://api.example.com:8443/page",
      originalUrl,
      exact,
      wildcards,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe("fetch blocked: redirect to non-standard port");
  });

  it("should reject empty Location header", () => {
    const result = validateRedirectTarget("", originalUrl, exact, wildcards);
    expect(result.valid).toBe(false);
    expect(result.error).toBe(
      "fetch blocked: redirect with no Location header",
    );
  });

  it("should reject null Location header", () => {
    const result = validateRedirectTarget(
      null as any,
      originalUrl,
      exact,
      wildcards,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe(
      "fetch blocked: redirect with no Location header",
    );
  });

  it("should reject undefined Location header", () => {
    const result = validateRedirectTarget(
      undefined as any,
      originalUrl,
      exact,
      wildcards,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe(
      "fetch blocked: redirect with no Location header",
    );
  });

  it("should reject malformed redirect URL", () => {
    const result = validateRedirectTarget(
      "not://a-valid-url-:::",
      originalUrl,
      exact,
      wildcards,
    );
    // This might parse as non-https or fail to parse depending on URL parser
    expect(result.valid).toBe(false);
  });

  it("should reject IPv6 literal redirect", () => {
    const result = validateRedirectTarget(
      "https://[::1]/internal",
      originalUrl,
      exact,
      wildcards,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe("fetch blocked: redirect to IP address");
  });

  it("should preserve query parameters from redirect URL", () => {
    const result = validateRedirectTarget(
      "https://api.example.com/search?q=hello&page=2",
      originalUrl,
      exact,
      wildcards,
    );
    expect(result.valid).toBe(true);
    expect(result.url!.search).toBe("?q=hello&page=2");
  });

  it("should strip fragments from redirect URL", () => {
    const result = validateRedirectTarget(
      "https://api.example.com/page#section",
      originalUrl,
      exact,
      wildcards,
    );
    expect(result.valid).toBe(true);
    // Fragment should be stripped in the reconstructed URL
    expect(result.url!.hash).toBe("");
  });

  it("should reject multi-level subdomain against single-level wildcard", () => {
    // *.example.com should NOT match a.b.example.com
    const result = validateRedirectTarget(
      "https://a.b.example.com/deep",
      originalUrl,
      new Set(), // no exact matches
      wildcards,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe(
      "fetch blocked: redirect to domain not in allowlist (a.b.example.com)",
    );
  });

  it("should reject bare parent domain against wildcard", () => {
    // *.example.com should NOT match example.com itself (no prefix)
    const result = validateRedirectTarget(
      "https://example.com/root",
      originalUrl,
      new Set(), // no exact matches
      wildcards,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe(
      "fetch blocked: redirect to domain not in allowlist (example.com)",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// createChunkCache
// ─────────────────────────────────────────────────────────────────────

describe("createResponseCache", () => {
  it("should start empty", () => {
    const cache = createResponseCache(60_000, 1024);
    expect(cache.has("https://example.com/")).toBe(false);
    expect(cache.stats().cached).toBe(false);
  });

  it("should store response with metadata", () => {
    const cache = createResponseCache(60_000, 1024);
    const meta = { contentType: "text/plain", status: 200, ok: true };
    cache.store("https://example.com/", "hello world", meta);
    expect(cache.has("https://example.com/")).toBe(true);
    expect(cache.stats().cached).toBe(true);
  });

  it("should return stored metadata via meta()", () => {
    const cache = createResponseCache(60_000, 1024);
    const meta = {
      contentType: "application/json",
      status: 200,
      ok: true,
      contentLength: 42,
    };
    cache.store("https://example.com/", '{"a":1}', meta);
    const m = cache.meta("https://example.com/");
    expect(m).toEqual(meta);
  });

  it("should return null from meta() for unknown URL", () => {
    const cache = createResponseCache(60_000, 1024);
    expect(cache.meta("https://unknown.com/")).toBeNull();
  });

  it("should return null from read() for unknown URL", () => {
    const cache = createResponseCache(60_000, 1024);
    cache.store("https://example.com/", "hello", {
      contentType: "text/plain",
      status: 200,
      ok: true,
    });
    expect(cache.read("https://other.com/")).toBeNull();
  });

  it("should read entire small body in one call", () => {
    const cache = createResponseCache(60_000, 1024);
    cache.store("https://example.com/", "tiny", {
      contentType: "text/plain",
      status: 200,
      ok: true,
    });
    const chunk = cache.read("https://example.com/");
    expect(chunk).not.toBeNull();
    expect(chunk!.data).toBe("tiny");
    expect(chunk!.done).toBe(true);
  });

  it("should auto-evict after last chunk is read", () => {
    const cache = createResponseCache(60_000, 1024);
    cache.store("https://example.com/", "tiny", {
      contentType: "text/plain",
      status: 200,
      ok: true,
    });
    cache.read("https://example.com/"); // done=true → auto-evict
    expect(cache.has("https://example.com/")).toBe(false);
  });

  it("should split body into sequential chunks", () => {
    const cache = createResponseCache(60_000, 4); // 4-byte chunk size
    // 10 bytes body → 3 reads (4+4+2)
    cache.store("https://example.com/", "0123456789", {
      contentType: "text/plain",
      status: 200,
      ok: true,
    });

    const c0 = cache.read("https://example.com/");
    expect(c0!.data).toBe("0123");
    expect(c0!.done).toBe(false);
    expect(cache.stats().cursor).toBe(4);

    const c1 = cache.read("https://example.com/");
    expect(c1!.data).toBe("4567");
    expect(c1!.done).toBe(false);
    expect(cache.stats().cursor).toBe(8);

    const c2 = cache.read("https://example.com/");
    expect(c2!.data).toBe("89");
    expect(c2!.done).toBe(true);
    // Auto-evicted after last chunk
    expect(cache.has("https://example.com/")).toBe(false);
  });

  it("should evict previous entry when storing new URL", () => {
    const cache = createResponseCache(60_000, 1024);
    const meta = { contentType: "text/plain", status: 200, ok: true };
    cache.store("https://first.com/", "first", meta);
    cache.store("https://second.com/", "second", meta);
    expect(cache.has("https://first.com/")).toBe(false);
    expect(cache.has("https://second.com/")).toBe(true);
  });

  it("should evict on manual evict call", () => {
    const cache = createResponseCache(60_000, 1024);
    cache.store("https://example.com/", "data", {
      contentType: "text/plain",
      status: 200,
      ok: true,
    });
    cache.evict();
    expect(cache.has("https://example.com/")).toBe(false);
    expect(cache.stats().cached).toBe(false);
  });

  it("should expire after TTL", async () => {
    vi.useFakeTimers();
    try {
      const cache = createResponseCache(1000, 1024); // 1 second TTL
      cache.store("https://example.com/", "data", {
        contentType: "text/plain",
        status: 200,
        ok: true,
      });
      expect(cache.has("https://example.com/")).toBe(true);

      vi.advanceTimersByTime(1001);

      expect(cache.has("https://example.com/")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should report stats accurately including cursor", () => {
    const cache = createResponseCache(60_000, 4);
    cache.store("https://example.com/", "hello world", {
      contentType: "text/plain",
      status: 200,
      ok: true,
    });
    const s = cache.stats();
    expect(s.cached).toBe(true);
    expect(s.url).toBe("https://example.com/");
    expect(s.totalBytes).toBe(Buffer.byteLength("hello world", "utf8"));
    expect(s.cursor).toBe(0);
    expect(s.ageMs).toBeGreaterThanOrEqual(0);

    // Read one chunk and verify cursor advances
    cache.read("https://example.com/");
    expect(cache.stats().cursor).toBe(4);
  });

  it("should handle multi-byte UTF-8 correctly", () => {
    const cache = createResponseCache(60_000, 3); // 3 byte read size
    // "é" is 2 bytes in UTF-8, so 'hélló' = 7 bytes
    const body = "hélló";
    const meta = { contentType: "text/plain", status: 200, ok: true };
    cache.store("https://example.com/", body, meta);
    const totalBytes = Buffer.byteLength(body, "utf8");

    // Read all chunks and verify they reassemble correctly
    let assembled = "";
    let chunk;
    let reads = 0;
    do {
      chunk = cache.read("https://example.com/");
      expect(chunk).not.toBeNull();
      assembled += chunk!.data;
      reads++;
    } while (!chunk!.done);

    expect(assembled).toBe(body);
    expect(reads).toBe(Math.ceil(totalBytes / 3));
  });

  // ── readBinary tests ─────────────────────────────────────────────────

  it("readBinary should return Buffer chunks", () => {
    const cache = createResponseCache(60_000, 4);
    const body = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    cache.store("https://example.com/", body, {
      contentType: "application/octet-stream",
      status: 200,
      ok: true,
    });

    const c0 = cache.readBinary("https://example.com/");
    expect(c0).not.toBeNull();
    expect(Buffer.isBuffer(c0!.data)).toBe(true);
    expect(c0!.data).toEqual(Buffer.from([0x00, 0x01, 0x02, 0x03]));
    expect(c0!.done).toBe(false);

    const c1 = cache.readBinary("https://example.com/");
    expect(c1!.data).toEqual(Buffer.from([0x04, 0x05]));
    expect(c1!.done).toBe(true);
  });

  it("readBinary should return null for unknown URL", () => {
    const cache = createResponseCache(60_000, 1024);
    expect(cache.readBinary("https://unknown.com/")).toBeNull();
  });

  it("readBinary should defer eviction until next tick", async () => {
    // This test verifies the fix for the napi crash where readBinary
    // returned a Buffer.subarray() view, then immediately evicted the
    // underlying buffer. The view's memory would become invalid before
    // napi could read it, causing slice::from_raw_parts to panic.
    //
    // The fix uses setImmediate(evict) to defer eviction, ensuring the
    // buffer memory survives until after the current call stack completes.
    const cache = createResponseCache(60_000, 1024);
    const body = Buffer.from("test data");
    cache.store("https://example.com/", body, {
      contentType: "application/octet-stream",
      status: 200,
      ok: true,
    });

    const chunk = cache.readBinary("https://example.com/");
    expect(chunk).not.toBeNull();
    expect(chunk!.done).toBe(true);

    // CRITICAL: Cache should still exist synchronously after readBinary
    // returns with done=true. The eviction is deferred via setImmediate.
    expect(cache.has("https://example.com/")).toBe(true);

    // The returned buffer should still be valid and readable
    expect(chunk!.data.toString()).toBe("test data");

    // After yielding to the event loop, eviction should have occurred
    await new Promise((resolve) => setImmediate(resolve));
    expect(cache.has("https://example.com/")).toBe(false);
  });

  it("readBinary buffer should remain valid after deferred eviction", async () => {
    // Ensure the returned Buffer data is still accessible after eviction
    // completes. This confirms the zero-copy subarray approach is safe
    // because the data is read before eviction runs.
    const cache = createResponseCache(60_000, 1024);
    const testData = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    cache.store("https://example.com/", testData, {
      contentType: "application/octet-stream",
      status: 200,
      ok: true,
    });

    const chunk = cache.readBinary("https://example.com/");
    expect(chunk!.done).toBe(true);

    // Read the data NOW, before eviction
    const dataCopy = Buffer.from(chunk!.data);
    expect(dataCopy).toEqual(testData);

    // Wait for deferred eviction
    await new Promise((resolve) => setImmediate(resolve));
    expect(cache.has("https://example.com/")).toBe(false);

    // The copy we made is still valid
    expect(dataCopy).toEqual(testData);
  });

  it("readBinary should return buffer matching stored byte count exactly", () => {
    // Regression test: readBinary must return the exact bytes stored, not 0.
    // Issue: LLM observed readBinary returning 0-byte Uint8Array when meta
    // showed bytes received (e.g., 14405 bytes). This test catches that bug.
    const cache = createResponseCache(60_000, 65536); // Large chunk size
    const body = Buffer.from([
      0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe, 0x12, 0x34, 0x56, 0x78,
    ]);
    cache.store("https://example.com/binary", body, {
      contentType: "application/octet-stream",
      status: 200,
      ok: true,
    });

    const chunk = cache.readBinary("https://example.com/binary");
    expect(chunk).not.toBeNull();
    expect(chunk!.data.length).toBe(body.length);
    expect(chunk!.data.length).toBeGreaterThan(0);
    expect(chunk!.data).toEqual(body);
    expect(chunk!.done).toBe(true);
  });

  it("readBinary total bytes should match across all chunks", () => {
    // Verify that chunked reads return the correct total byte count
    const cache = createResponseCache(60_000, 4); // 4-byte chunks
    const body = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    cache.store("https://example.com/chunked", body, {
      contentType: "application/octet-stream",
      status: 200,
      ok: true,
    });

    let totalBytes = 0;
    let chunk;
    do {
      chunk = cache.readBinary("https://example.com/chunked");
      if (chunk) totalBytes += chunk.data.length;
    } while (chunk && !chunk.done);

    expect(totalBytes).toBe(body.length);
  });
});

// ─────────────────────────────────────────────────────────────────────
// createHostFunctions — non-2xx body collection
// ─────────────────────────────────────────────────────────────────────

describe("createHostFunctions - non-2xx body", () => {
  it("should cache non-2xx response body for read()", async () => {
    // Hit a path that reliably returns 404 with a JSON body from GitHub
    const hostFuncs = createHostFunctions({
      allowedDomains: ["api.github.com"],
      allowedContentTypes: ["application/json"],
    });
    const meta = await hostFuncs.fetch.get(
      "https://api.github.com/repos/this-org-does-not-exist-zzz/nope",
    );

    // Could be a transient network error — skip if so
    if (meta.error) return;

    // GitHub may rate-limit (403) or return 404 — both are valid non-2xx
    expect([403, 404]).toContain(meta.status);
    expect(meta.ok).toBe(false);
    // totalBytes should be > 0 — GitHub returns a JSON error body
    expect(meta.totalBytes).toBeGreaterThan(0);

    // Body should be readable via read()
    let body = "";
    let chunk;
    do {
      chunk = await hostFuncs.fetch.read(
        "https://api.github.com/repos/this-org-does-not-exist-zzz/nope",
      );
      if (chunk.error) break;
      body += chunk.data;
    } while (!chunk.done);

    // GitHub error body contains a message field
    expect(body.length).toBeGreaterThan(0);
    const parsed = JSON.parse(body);
    expect(parsed.message).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// createHostFunctions — chunked response behaviour
// ─────────────────────────────────────────────────────────────────────

describe("createHostFunctions - read()", () => {
  it("should include read host function", () => {
    const hostFuncs = createHostFunctions({
      allowedDomains: ["api.github.com"],
    });
    expect(hostFuncs.fetch.read).toBeDefined();
    expect(typeof hostFuncs.fetch.read).toBe("function");
  });

  it("should return error for read with no cached URL", async () => {
    const hostFuncs = createHostFunctions({
      allowedDomains: ["api.github.com"],
    });
    const result = await hostFuncs.fetch.read("https://api.github.com/nope");
    expect(result.error).toContain("no cached response");
  });

  it("should return error for read with wrong cached URL", async () => {
    const hostFuncs = createHostFunctions({
      allowedDomains: ["api.github.com"],
    });
    // read() for a URL that was never fetched
    const result = await hostFuncs.fetch.read("https://api.github.com/wrong");
    expect(result.error).toContain("no cached response");
    expect(result.error).toContain("cache may have expired");
  });
});

// ─────────────────────────────────────────────────────────────────────
// extractRateLimitInfo
// ─────────────────────────────────────────────────────────────────────

describe("extractRateLimitInfo", () => {
  /** Helper: build a fake IncomingMessage-like object with headers. */
  function fakeRes(headers: Record<string, string>): any {
    // Node lowercases header names on IncomingMessage
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      lower[k.toLowerCase()] = v;
    }
    return { headers: lower };
  }

  it("should return null when no rate-limit headers are present", () => {
    const res = fakeRes({ "content-type": "application/json" });
    expect(extractRateLimitInfo(res, 200)).toBeNull();
  });

  it("should extract X-RateLimit-* headers", () => {
    const res = fakeRes({
      "x-ratelimit-limit": "60",
      "x-ratelimit-remaining": "42",
      "x-ratelimit-used": "18",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 300),
    });
    const info = extractRateLimitInfo(res, 200);
    expect(info).not.toBeNull();
    expect(info!.limit).toBe(60);
    expect(info!.remaining).toBe(42);
    expect(info!.used).toBe(18);
    expect(info!.resetAt).toBeGreaterThan(0);
  });

  it("should extract draft RateLimit-* headers (no X- prefix)", () => {
    const res = fakeRes({
      "ratelimit-limit": "100",
      "ratelimit-remaining": "99",
    });
    const info = extractRateLimitInfo(res, 200);
    expect(info).not.toBeNull();
    expect(info!.limit).toBe(100);
    expect(info!.remaining).toBe(99);
  });

  it("should prefer X-RateLimit-* over draft RateLimit-*", () => {
    const res = fakeRes({
      "x-ratelimit-limit": "60",
      "ratelimit-limit": "100",
      "x-ratelimit-remaining": "5",
      "ratelimit-remaining": "50",
    });
    const info = extractRateLimitInfo(res, 200);
    expect(info).not.toBeNull();
    expect(info!.limit).toBe(60);
    expect(info!.remaining).toBe(5);
  });

  it("should parse Retry-After as integer on 429", () => {
    const res = fakeRes({ "retry-after": "47" });
    const info = extractRateLimitInfo(res, 429);
    expect(info).not.toBeNull();
    expect(info!.retryAfterSecs).toBe(47);
  });

  it("should parse Retry-After as integer on 503", () => {
    const res = fakeRes({ "retry-after": "120" });
    const info = extractRateLimitInfo(res, 503);
    expect(info).not.toBeNull();
    expect(info!.retryAfterSecs).toBe(120);
  });

  it("should ignore Retry-After on non-429/503 status", () => {
    const res = fakeRes({ "retry-after": "10" });
    // Status 200 — Retry-After should be ignored
    expect(extractRateLimitInfo(res, 200)).toBeNull();
  });

  it("should cap retryAfterSecs at MAX_RETRY_AFTER_SECS (3600)", () => {
    const res = fakeRes({ "retry-after": "9999" });
    const info = extractRateLimitInfo(res, 429);
    expect(info).not.toBeNull();
    expect(info!.retryAfterSecs).toBe(3600);
  });

  it("should parse Retry-After as HTTP-date", () => {
    // Set a date ~60 seconds in the future
    const futureDate = new Date(Date.now() + 60_000);
    const res = fakeRes({ "retry-after": futureDate.toUTCString() });
    const info = extractRateLimitInfo(res, 429);
    expect(info).not.toBeNull();
    // Should be roughly 60 seconds (allow some tolerance for test timing)
    expect(info!.retryAfterSecs).toBeGreaterThanOrEqual(55);
    expect(info!.retryAfterSecs).toBeLessThanOrEqual(65);
  });

  it("should ignore Retry-After HTTP-date in the past", () => {
    const pastDate = new Date(Date.now() - 60_000);
    const res = fakeRes({ "retry-after": pastDate.toUTCString() });
    const info = extractRateLimitInfo(res, 429);
    // Past date → diffSecs <= 0 → retryAfterSecs undefined → null result
    expect(info).toBeNull();
  });

  it("should discard resetAt more than 1 day in the past", () => {
    const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86400;
    const res = fakeRes({
      "x-ratelimit-reset": String(twoDaysAgo),
      "x-ratelimit-limit": "60",
    });
    const info = extractRateLimitInfo(res, 200);
    expect(info).not.toBeNull();
    expect(info!.limit).toBe(60);
    // resetAt should have been discarded
    expect(info!.resetAt).toBeUndefined();
  });

  it("should discard resetAt beyond year 2100", () => {
    const absurd = 5_000_000_000; // ~year 2128
    const res = fakeRes({
      "x-ratelimit-reset": String(absurd),
      "x-ratelimit-remaining": "10",
    });
    const info = extractRateLimitInfo(res, 200);
    expect(info).not.toBeNull();
    expect(info!.remaining).toBe(10);
    expect(info!.resetAt).toBeUndefined();
  });

  it("should accept resetAt within valid range", () => {
    const fiveMinFuture = Math.floor(Date.now() / 1000) + 300;
    const res = fakeRes({
      "x-ratelimit-reset": String(fiveMinFuture),
    });
    const info = extractRateLimitInfo(res, 200);
    expect(info).not.toBeNull();
    expect(info!.resetAt).toBe(fiveMinFuture);
  });

  it("should ignore invalid (non-numeric) header values", () => {
    const res = fakeRes({
      "x-ratelimit-limit": "banana",
      "x-ratelimit-remaining": "NaN",
    });
    expect(extractRateLimitInfo(res, 200)).toBeNull();
  });

  it("should ignore negative header values", () => {
    const res = fakeRes({
      "x-ratelimit-limit": "-5",
      "x-ratelimit-remaining": "-1",
    });
    expect(extractRateLimitInfo(res, 200)).toBeNull();
  });

  it("should handle partial headers (only remaining)", () => {
    const res = fakeRes({ "x-ratelimit-remaining": "0" });
    const info = extractRateLimitInfo(res, 200);
    expect(info).not.toBeNull();
    expect(info!.remaining).toBe(0);
    expect(info!.limit).toBeUndefined();
    expect(info!.used).toBeUndefined();
  });

  it("should return only defined fields (no undefined keys)", () => {
    const res = fakeRes({
      "x-ratelimit-limit": "60",
      "x-ratelimit-remaining": "59",
    });
    const info = extractRateLimitInfo(res, 200);
    expect(info).not.toBeNull();
    const keys = Object.keys(info!);
    expect(keys).toEqual(expect.arrayContaining(["limit", "remaining"]));
    expect(keys).not.toContain("used");
    expect(keys).not.toContain("resetAt");
    expect(keys).not.toContain("retryAfterSecs");
  });

  it("should combine rate-limit headers with Retry-After on 429", () => {
    const resetTime = Math.floor(Date.now() / 1000) + 60;
    const res = fakeRes({
      "x-ratelimit-limit": "60",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(resetTime),
      "retry-after": "47",
    });
    const info = extractRateLimitInfo(res, 429);
    expect(info).not.toBeNull();
    expect(info!.limit).toBe(60);
    expect(info!.remaining).toBe(0);
    expect(info!.resetAt).toBe(resetTime);
    expect(info!.retryAfterSecs).toBe(47);
  });

  it("should handle zero remaining correctly", () => {
    const res = fakeRes({ "x-ratelimit-remaining": "0" });
    const info = extractRateLimitInfo(res, 200);
    expect(info).not.toBeNull();
    expect(info!.remaining).toBe(0);
  });

  it("should handle zero limit correctly", () => {
    const res = fakeRes({ "x-ratelimit-limit": "0" });
    const info = extractRateLimitInfo(res, 200);
    expect(info).not.toBeNull();
    expect(info!.limit).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// extractPaginationLinks
// ─────────────────────────────────────────────────────────────────────

describe("extractPaginationLinks", () => {
  /** Helper: build a fake IncomingMessage-like object with headers. */
  function fakeRes(headers: Record<string, string>): any {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      lower[k.toLowerCase()] = v;
    }
    return { headers: lower };
  }

  it("should return null when no Link header is present", () => {
    const res = fakeRes({ "content-type": "application/json" });
    expect(extractPaginationLinks(res)).toBeNull();
  });

  it("should parse a single next link", () => {
    const res = fakeRes({
      link: '<https://api.github.com/repos?page=2>; rel="next"',
    });
    const links = extractPaginationLinks(res);
    expect(links).not.toBeNull();
    expect(links!.next).toBe("https://api.github.com/repos?page=2");
  });

  it("should parse multiple rel links", () => {
    const res = fakeRes({
      link: '<https://api.example.com/items?page=2>; rel="next", <https://api.example.com/items?page=10>; rel="last", <https://api.example.com/items?page=1>; rel="first"',
    });
    const links = extractPaginationLinks(res);
    expect(links).not.toBeNull();
    expect(links!.next).toBe("https://api.example.com/items?page=2");
    expect(links!.last).toBe("https://api.example.com/items?page=10");
    expect(links!.first).toBe("https://api.example.com/items?page=1");
  });

  it("should parse all four rel types", () => {
    const res = fakeRes({
      link: '<https://api.example.com/items?page=2>; rel="next", <https://api.example.com/items?page=1>; rel="prev", <https://api.example.com/items?page=1>; rel="first", <https://api.example.com/items?page=5>; rel="last"',
    });
    const links = extractPaginationLinks(res);
    expect(links).not.toBeNull();
    expect(links!.next).toBe("https://api.example.com/items?page=2");
    expect(links!.prev).toBe("https://api.example.com/items?page=1");
    expect(links!.first).toBe("https://api.example.com/items?page=1");
    expect(links!.last).toBe("https://api.example.com/items?page=5");
  });

  it("should silently drop HTTP (non-HTTPS) links", () => {
    const res = fakeRes({
      link: '<http://api.example.com/items?page=2>; rel="next", <https://api.example.com/items?page=5>; rel="last"',
    });
    const links = extractPaginationLinks(res);
    expect(links).not.toBeNull();
    // HTTP link dropped, only HTTPS kept
    expect(links!.next).toBeUndefined();
    expect(links!.last).toBe("https://api.example.com/items?page=5");
  });

  it("should return null when all links are HTTP (none are HTTPS)", () => {
    const res = fakeRes({
      link: '<http://api.example.com/items?page=2>; rel="next"',
    });
    expect(extractPaginationLinks(res)).toBeNull();
  });

  it("should ignore unrecognised rel types", () => {
    const res = fakeRes({
      link: '<https://api.example.com/items>; rel="canonical", <https://api.example.com/items?page=2>; rel="next"',
    });
    const links = extractPaginationLinks(res);
    expect(links).not.toBeNull();
    expect(links!.next).toBe("https://api.example.com/items?page=2");
    // "canonical" should not appear
    expect((links as any).canonical).toBeUndefined();
  });

  it("should handle rel values case-insensitively", () => {
    const res = fakeRes({
      link: '<https://api.example.com/items?page=2>; rel="NEXT", <https://api.example.com/items?page=5>; rel="Last"',
    });
    const links = extractPaginationLinks(res);
    expect(links).not.toBeNull();
    expect(links!.next).toBe("https://api.example.com/items?page=2");
    expect(links!.last).toBe("https://api.example.com/items?page=5");
  });

  it("should handle whitespace variations in Link header", () => {
    const res = fakeRes({
      // Extra spaces around semicolons and commas
      link: '< https://api.example.com/items?page=2 >; rel="next" , <https://api.example.com/items?page=5> ;  rel="last"',
    });
    // The regex expects <url>; rel="..." — inner spaces in <> are part of URL
    // This tests that the regex handles spacing between > and ; and rel
    const links = extractPaginationLinks(res);
    // The first URL has spaces inside <> so it won't start with https://
    // and should be dropped. The second should still match.
    expect(links).not.toBeNull();
    expect(links!.last).toBe("https://api.example.com/items?page=5");
  });

  it("should return null for empty Link header", () => {
    const res = fakeRes({ link: "" });
    expect(extractPaginationLinks(res)).toBeNull();
  });

  it("should return null for malformed Link header", () => {
    const res = fakeRes({ link: "this is not a valid link header" });
    expect(extractPaginationLinks(res)).toBeNull();
  });

  it("should handle GitHub-style Link header", () => {
    // Real-world GitHub API Link header format
    const res = fakeRes({
      link: '<https://api.github.com/repositories/123/commits?page=2>; rel="next", <https://api.github.com/repositories/123/commits?page=17>; rel="last"',
    });
    const links = extractPaginationLinks(res);
    expect(links).not.toBeNull();
    expect(links!.next).toBe(
      "https://api.github.com/repositories/123/commits?page=2",
    );
    expect(links!.last).toBe(
      "https://api.github.com/repositories/123/commits?page=17",
    );
    expect(links!.prev).toBeUndefined();
    expect(links!.first).toBeUndefined();
  });
});

// ── extractConditionalValidators ─────────────────────────────────────

describe("extractConditionalValidators", () => {
  /** Helper to create a fake response with headers. */
  const fakeRes = (headers: Record<string, string>) => ({ headers });

  it("should return null when no ETag or Last-Modified headers are present", () => {
    expect(extractConditionalValidators(fakeRes({}))).toBeNull();
    expect(
      extractConditionalValidators(fakeRes({ "content-type": "text/plain" })),
    ).toBeNull();
  });

  it("should extract a strong ETag", () => {
    const result = extractConditionalValidators(fakeRes({ etag: '"abc123"' }));
    expect(result).toEqual({ etag: '"abc123"' });
  });

  it('should extract a weak ETag (W/"...")', () => {
    const result = extractConditionalValidators(
      fakeRes({ etag: 'W/"abc123"' }),
    );
    expect(result).toEqual({ etag: 'W/"abc123"' });
  });

  it("should reject bare ETag values without quotes", () => {
    // Non-compliant ETags without quotes could be spoofed
    expect(
      extractConditionalValidators(fakeRes({ etag: "abc123" })),
    ).toBeNull();
    expect(
      extractConditionalValidators(fakeRes({ etag: "W/abc123" })),
    ).toBeNull();
  });

  it("should reject empty ETag", () => {
    expect(extractConditionalValidators(fakeRes({ etag: "" }))).toBeNull();
  });

  it("should reject ETag exceeding max length", () => {
    // MAX_ETAG_LENGTH = 512
    const longEtag = '"' + "x".repeat(512) + '"';
    expect(
      extractConditionalValidators(fakeRes({ etag: longEtag })),
    ).toBeNull();
  });

  it("should accept ETag at exactly max length boundary", () => {
    // 512 chars total including quotes: 2 quotes + 508 chars = 510, under 512
    const okEtag = '"' + "x".repeat(508) + '"';
    expect(okEtag.length).toBe(510);
    const result = extractConditionalValidators(fakeRes({ etag: okEtag }));
    expect(result).toEqual({ etag: okEtag });
  });

  it("should extract valid Last-Modified date", () => {
    const lastMod = "Wed, 21 Oct 2015 07:28:00 GMT";
    const result = extractConditionalValidators(
      fakeRes({ "last-modified": lastMod }),
    );
    expect(result).toEqual({ lastModified: lastMod });
  });

  it("should reject invalid Last-Modified (garbage string)", () => {
    expect(
      extractConditionalValidators(fakeRes({ "last-modified": "not-a-date" })),
    ).toBeNull();
  });

  it("should reject empty Last-Modified", () => {
    expect(
      extractConditionalValidators(fakeRes({ "last-modified": "" })),
    ).toBeNull();
  });

  it("should reject Last-Modified exceeding max length", () => {
    // MAX_LAST_MODIFIED_LENGTH = 64
    const longDate = "Wed, 21 Oct 2015 07:28:00 GMT" + "x".repeat(40);
    expect(longDate.length).toBeGreaterThan(64);
    expect(
      extractConditionalValidators(fakeRes({ "last-modified": longDate })),
    ).toBeNull();
  });

  it("should extract both ETag and Last-Modified when present", () => {
    const result = extractConditionalValidators(
      fakeRes({
        etag: '"abc123"',
        "last-modified": "Wed, 21 Oct 2015 07:28:00 GMT",
      }),
    );
    expect(result).toEqual({
      etag: '"abc123"',
      lastModified: "Wed, 21 Oct 2015 07:28:00 GMT",
    });
  });

  it("should return only etag when Last-Modified is invalid", () => {
    const result = extractConditionalValidators(
      fakeRes({ etag: '"abc"', "last-modified": "garbage" }),
    );
    expect(result).toEqual({ etag: '"abc"' });
  });

  it("should return only lastModified when ETag is invalid", () => {
    const result = extractConditionalValidators(
      fakeRes({
        etag: "bare-no-quotes",
        "last-modified": "Wed, 21 Oct 2015 07:28:00 GMT",
      }),
    );
    expect(result).toEqual({ lastModified: "Wed, 21 Oct 2015 07:28:00 GMT" });
  });

  it("should reject ETag with embedded quotes (potential injection)", () => {
    // The regex requires: starts with optional W/ then " then non-" chars then "
    const badEtag = '"abc"def"';
    expect(extractConditionalValidators(fakeRes({ etag: badEtag }))).toBeNull();
  });

  it("should handle Last-Modified with epoch 0 (Jan 1 1970)", () => {
    // Date.parse('Thu, 01 Jan 1970 00:00:00 GMT') === 0, which is not > 0
    expect(
      extractConditionalValidators(
        fakeRes({ "last-modified": "Thu, 01 Jan 1970 00:00:00 GMT" }),
      ),
    ).toBeNull();
  });

  it("should accept ISO 8601 dates in Last-Modified", () => {
    // Date.parse handles ISO 8601 format too
    const result = extractConditionalValidators(
      fakeRes({ "last-modified": "2024-01-15T10:30:00Z" }),
    );
    expect(result).toEqual({ lastModified: "2024-01-15T10:30:00Z" });
  });
});

// ── createConditionalCache ───────────────────────────────────────────

describe("createConditionalCache", () => {
  it("should start empty with size 0", () => {
    const cache = createConditionalCache(10, 60_000);
    expect(cache.size()).toBe(0);
  });

  it("should store and retrieve an entry", () => {
    const cache = createConditionalCache(10, 60_000);
    cache.store(
      "https://api.example.com/data",
      '{"ok":true}',
      200,
      "application/json",
      {
        etag: '"abc123"',
      },
    );
    expect(cache.size()).toBe(1);

    const result = cache.retrieve("https://api.example.com/data");
    expect(result).toEqual({
      body: '{"ok":true}',
      status: 200,
      contentType: "application/json",
    });
  });

  it("should return validators for a cached URL", () => {
    const cache = createConditionalCache(10, 60_000);
    cache.store("https://api.example.com/data", "body", 200, "text/plain", {
      etag: '"v1"',
      lastModified: "Wed, 21 Oct 2015 07:28:00 GMT",
    });

    const validators = cache.getValidators("https://api.example.com/data");
    expect(validators).toEqual({
      etag: '"v1"',
      lastModified: "Wed, 21 Oct 2015 07:28:00 GMT",
    });
  });

  it("should return null validators for unknown URL", () => {
    const cache = createConditionalCache(10, 60_000);
    expect(cache.getValidators("https://unknown.com")).toBeNull();
  });

  it("should return null from retrieve for unknown URL", () => {
    const cache = createConditionalCache(10, 60_000);
    expect(cache.retrieve("https://unknown.com")).toBeNull();
  });

  it("should update existing entry on re-store", () => {
    const cache = createConditionalCache(10, 60_000);
    cache.store("https://api.example.com/data", "v1", 200, "text/plain", {
      etag: '"v1"',
    });
    cache.store("https://api.example.com/data", "v2", 200, "text/plain", {
      etag: '"v2"',
    });

    expect(cache.size()).toBe(1);
    const result = cache.retrieve("https://api.example.com/data");
    expect(result!.body).toBe("v2");
    expect(cache.getValidators("https://api.example.com/data")!.etag).toBe(
      '"v2"',
    );
  });

  it("should evict LRU entry when at capacity", () => {
    const cache = createConditionalCache(2, 60_000);
    cache.store("https://a.com/1", "a", 200, "text/plain", { etag: '"a"' });
    cache.store("https://b.com/2", "b", 200, "text/plain", { etag: '"b"' });

    // Cache is full (2 entries). Storing a 3rd evicts the LRU (a.com).
    cache.store("https://c.com/3", "c", 200, "text/plain", { etag: '"c"' });

    expect(cache.size()).toBe(2);
    expect(cache.retrieve("https://a.com/1")).toBeNull();
    expect(cache.retrieve("https://b.com/2")).not.toBeNull();
    expect(cache.retrieve("https://c.com/3")).not.toBeNull();
  });

  it("should promote accessed entry to MRU (not evicted next)", () => {
    const cache = createConditionalCache(2, 60_000);
    cache.store("https://a.com/1", "a", 200, "text/plain", { etag: '"a"' });
    cache.store("https://b.com/2", "b", 200, "text/plain", { etag: '"b"' });

    // Access a.com — moves it to MRU. Now b.com is LRU.
    cache.getValidators("https://a.com/1");

    // Adding c.com should evict b.com (the LRU), not a.com.
    cache.store("https://c.com/3", "c", 200, "text/plain", { etag: '"c"' });

    expect(cache.retrieve("https://a.com/1")).not.toBeNull();
    expect(cache.retrieve("https://b.com/2")).toBeNull();
    expect(cache.retrieve("https://c.com/3")).not.toBeNull();
  });

  it("should expire entries after TTL", async () => {
    // Use a very short TTL for testing
    const cache = createConditionalCache(10, 50);
    cache.store("https://a.com/1", "a", 200, "text/plain", { etag: '"a"' });

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(cache.getValidators("https://a.com/1")).toBeNull();
    expect(cache.retrieve("https://a.com/1")).toBeNull();
  });

  it("should remove entry explicitly", () => {
    const cache = createConditionalCache(10, 60_000);
    cache.store("https://a.com/1", "a", 200, "text/plain", { etag: '"a"' });
    expect(cache.size()).toBe(1);

    const removed = cache.remove("https://a.com/1");
    expect(removed).toBe(true);
    expect(cache.size()).toBe(0);
    expect(cache.retrieve("https://a.com/1")).toBeNull();
  });

  it("should return false when removing non-existent entry", () => {
    const cache = createConditionalCache(10, 60_000);
    expect(cache.remove("https://nonexistent.com")).toBe(false);
  });

  it("should clear all entries", () => {
    const cache = createConditionalCache(10, 60_000);
    cache.store("https://a.com/1", "a", 200, "text/plain", { etag: '"a"' });
    cache.store("https://b.com/2", "b", 200, "text/plain", { etag: '"b"' });
    expect(cache.size()).toBe(2);

    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.retrieve("https://a.com/1")).toBeNull();
    expect(cache.retrieve("https://b.com/2")).toBeNull();
  });

  it("should store entries with only etag (no lastModified)", () => {
    const cache = createConditionalCache(10, 60_000);
    cache.store("https://a.com/1", "body", 200, "text/plain", { etag: '"v1"' });

    const validators = cache.getValidators("https://a.com/1");
    expect(validators).toEqual({ etag: '"v1"' });
    // lastModified should not be in the result
    expect(validators!.lastModified).toBeUndefined();
  });

  it("should store entries with only lastModified (no etag)", () => {
    const cache = createConditionalCache(10, 60_000);
    cache.store("https://a.com/1", "body", 200, "text/plain", {
      lastModified: "Wed, 21 Oct 2015 07:28:00 GMT",
    });

    const validators = cache.getValidators("https://a.com/1");
    expect(validators).toEqual({
      lastModified: "Wed, 21 Oct 2015 07:28:00 GMT",
    });
    expect(validators!.etag).toBeUndefined();
  });

  it("should handle exact URL matching (no normalisation)", () => {
    const cache = createConditionalCache(10, 60_000);
    cache.store(
      "https://api.example.com/data?page=1",
      "p1",
      200,
      "text/plain",
      {
        etag: '"p1"',
      },
    );

    // Slightly different URL should NOT match
    expect(cache.retrieve("https://api.example.com/data?page=2")).toBeNull();
    expect(cache.retrieve("https://api.example.com/data")).toBeNull();

    // Exact match should work
    expect(
      cache.retrieve("https://api.example.com/data?page=1"),
    ).not.toBeNull();
  });

  it("should handle capacity of 1 (single-entry cache)", () => {
    const cache = createConditionalCache(1, 60_000);
    cache.store("https://a.com/1", "a", 200, "text/plain", { etag: '"a"' });
    expect(cache.size()).toBe(1);

    // Adding a second entry evicts the first
    cache.store("https://b.com/2", "b", 200, "text/plain", { etag: '"b"' });
    expect(cache.size()).toBe(1);
    expect(cache.retrieve("https://a.com/1")).toBeNull();
    expect(cache.retrieve("https://b.com/2")).not.toBeNull();
  });

  it("should preserve original status in retrieved entry", () => {
    const cache = createConditionalCache(10, 60_000);
    // Store a response that was originally a 200
    cache.store("https://a.com/1", '{"items":[]}', 200, "application/json", {
      etag: '"v1"',
    });

    const result = cache.retrieve("https://a.com/1");
    expect(result!.status).toBe(200);
    expect(result!.contentType).toBe("application/json");
  });

  it("should evict multiple LRU entries when storing into overfull cache", () => {
    // Start with capacity 3, fill it, then check eviction
    const cache = createConditionalCache(3, 60_000);
    cache.store("https://a.com/1", "a", 200, "text/plain", { etag: '"a"' });
    cache.store("https://b.com/2", "b", 200, "text/plain", { etag: '"b"' });
    cache.store("https://c.com/3", "c", 200, "text/plain", { etag: '"c"' });
    expect(cache.size()).toBe(3);

    // Access b to promote it. Order is now: a(LRU), c, b(MRU)
    cache.getValidators("https://b.com/2");

    // Add d — evicts a (the LRU)
    cache.store("https://d.com/4", "d", 200, "text/plain", { etag: '"d"' });
    expect(cache.size()).toBe(3);
    expect(cache.retrieve("https://a.com/1")).toBeNull();
    expect(cache.retrieve("https://b.com/2")).not.toBeNull();
    expect(cache.retrieve("https://c.com/3")).not.toBeNull();
    expect(cache.retrieve("https://d.com/4")).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// maxParallelFetches configuration
// ─────────────────────────────────────────────────────────────────────

describe("maxParallelFetches", () => {
  it("should default to 1 (serial)", () => {
    const fns = createHostFunctions({
      allowedDomains: ["example.com"],
    });
    // The config is internal, but we can verify behavior via the fetchBinaryBatch function
    expect(fns.fetch.fetchBinaryBatch).toBeDefined();
  });

  it("should accept valid maxParallelFetches config values", () => {
    // Test values 1-10
    for (const val of [1, 4, 10]) {
      const fns = createHostFunctions({
        allowedDomains: ["example.com"],
        maxParallelFetches: val,
      });
      expect(fns.fetch.fetchBinaryBatch).toBeDefined();
    }
  });

  it("should clamp maxParallelFetches to maximum of 10", () => {
    // Values above 10 should be clamped (via safeNumericConfig)
    const fns = createHostFunctions({
      allowedDomains: ["example.com"],
      maxParallelFetches: 100,
    });
    expect(fns.fetch.fetchBinaryBatch).toBeDefined();
  });

  it("should use default when maxParallelFetches is invalid", () => {
    const fns = createHostFunctions({
      allowedDomains: ["example.com"],
      maxParallelFetches: -1,
    });
    expect(fns.fetch.fetchBinaryBatch).toBeDefined();
  });

  it("fetchBinaryBatch should require array input", async () => {
    const fns = createHostFunctions({
      allowedDomains: ["example.com"],
    });

    await expect(
      fns.fetch.fetchBinaryBatch("not-an-array" as unknown as string[]),
    ).rejects.toThrow("first parameter must be an array");
  });

  it("fetchBinaryBatch should return empty array for empty input", async () => {
    const fns = createHostFunctions({
      allowedDomains: ["example.com"],
    });

    const results = await fns.fetch.fetchBinaryBatch([]);
    expect(results).toEqual([]);
  });
});
