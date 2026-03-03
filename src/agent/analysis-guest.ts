// ── agent/analysis-guest.ts — TypeScript wrapper for Hyperlight Analysis Guest ──
//
// Provides a safe, typed interface for code analysis operations that run
// in an isolated Hyperlight micro-VM. All parsing and pattern matching
// happens in the guest, protecting the host from ReDoS vulnerabilities.
//
// ──────────────────────────────────────────────────────────────────────────

import type {
  ExportInfo,
  ModuleMetadataResponse,
  PluginConfigSchema,
  SchemaField,
  ScanFinding,
  ScanPluginResponse,
  ValidationContext,
  ValidationIssue,
  ValidationResponse,
} from "hyperlight-analysis";

// ── Feature Flag ──────────────────────────────────────────────────────────

/**
 * Feature flag to enable/disable the analysis guest.
 * When disabled, falls back to legacy host-side implementations.
 */
let analysisGuestEnabled = false;

/**
 * Enable the analysis guest for secure code processing.
 * Call this after verifying the native addon is available.
 */
export function enableAnalysisGuest(): void {
  analysisGuestEnabled = true;
}

/**
 * Disable the analysis guest (use legacy host-side implementations).
 */
export function disableAnalysisGuest(): void {
  analysisGuestEnabled = false;
}

/**
 * Check if the analysis guest is enabled.
 */
export function isAnalysisGuestEnabled(): boolean {
  return analysisGuestEnabled;
}

// ── Lazy Loading ──────────────────────────────────────────────────────────

// The native addon is loaded lazily to avoid startup failures if it's not built
let nativeModule: typeof import("hyperlight-analysis") | null = null;
let loadError: Error | null = null;

async function getNativeModule(): Promise<
  typeof import("hyperlight-analysis")
> {
  if (nativeModule) return nativeModule;
  if (loadError) throw loadError;

  try {
    // Dynamic import to handle missing native addon gracefully
    // CJS modules get wrapped - named exports are on .default
    const imported = (await import("hyperlight-analysis")) as unknown as {
      default?: typeof import("hyperlight-analysis");
    } & typeof import("hyperlight-analysis");
    nativeModule = imported.default ?? imported;
    return nativeModule;
  } catch (e) {
    loadError = e instanceof Error ? e : new Error(String(e));
    throw loadError;
  }
}

/**
 * Check if the native addon is available.
 * Returns info about the runtime if available.
 */
export async function checkAvailability(): Promise<{
  available: boolean;
  hash?: string;
  size?: number;
  error?: string;
}> {
  try {
    const mod = await getNativeModule();
    return {
      available: true,
      hash: mod.getRuntimeHash(),
      size: mod.getRuntimeSize(),
    };
  } catch (e) {
    return {
      available: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Ping the analysis guest to verify it's working.
 * @param input - String to echo back
 * @returns The input echoed back in a message response
 */
export async function ping(input: string): Promise<{ message: string }> {
  const mod = await getNativeModule();
  const result = await mod.ping(input);
  return JSON.parse(result) as { message: string };
}

/**
 * Extract module metadata from JavaScript source code.
 *
 * Parses the source in the isolated guest to extract:
 * - Export signatures (functions, classes, constants)
 * - JSDoc comments and type annotations
 * - `_HINTS` export for LLM guidance
 *
 * @param source - JavaScript ES module source code
 * @returns Extracted metadata
 */
export async function extractModuleMetadata(
  source: string,
): Promise<ModuleMetadataResponse> {
  const mod = await getNativeModule();
  const result = await mod.extractModuleMetadata(source);
  return JSON.parse(result) as ModuleMetadataResponse;
}

/**
 * Extract module metadata from a TypeScript declaration (.d.ts) file.
 *
 * Parses .d.ts files in the isolated guest which have cleaner type information:
 * - `export declare function name(params): returnType;`
 * - `export interface Name { ... }`
 * - `export declare const name: Type;`
 *
 * @param source - TypeScript declaration file content
 * @returns Extracted metadata (same format as extractModuleMetadata)
 */
export async function extractDtsMetadata(
  source: string,
): Promise<ModuleMetadataResponse> {
  const mod = await getNativeModule();
  const result = await mod.extractDtsMetadata(source);
  return JSON.parse(result) as ModuleMetadataResponse;
}

/**
 * Extract plugin metadata including SCHEMA and _HINTS from TypeScript source.
 *
 * This is the primary interface for plugin discovery. All parsing happens
 * in the isolated Rust guest - no code execution, no security risk.
 *
 * Extracts:
 * - `export const SCHEMA = {...} satisfies ConfigSchema` → schema field
 * - `export const _HINTS = \`...\`` → hints field
 * - Export signatures (functions, classes, constants)
 *
 * @param source - Plugin TypeScript source code (index.ts)
 * @returns Extracted metadata with schema and hints
 */
export async function extractPluginMetadata(
  source: string,
): Promise<ModuleMetadataResponse> {
  const mod = await getNativeModule();
  // Pass config with extractSchema: true
  const config = JSON.stringify({ extractSchema: true });
  const result = await mod.extractModuleMetadata(source, config);
  return JSON.parse(result) as ModuleMetadataResponse;
}

/**
 * Scan plugin source code for security issues.
 *
 * Performs static analysis in the isolated guest to detect:
 * - Dangerous patterns (eval, child_process, etc.)
 * - Suspicious code constructs
 * - Policy violations
 *
 * @param source - Plugin JavaScript source code
 * @returns Scan findings
 */
export async function scanPlugin(source: string): Promise<ScanPluginResponse> {
  const mod = await getNativeModule();
  const result = await mod.scanPlugin(source);
  return JSON.parse(result) as ScanPluginResponse;
}

/**
 * Validate JavaScript source code for syntax errors and common issues.
 *
 * This is the primary interface for LLM code validation before handler
 * registration. All parsing happens in the isolated guest using the same
 * QuickJS parser as the runtime, ensuring perfect fidelity.
 *
 * @param source - JavaScript source code to validate
 * @param context - Validation context with handler name, available modules, etc.
 * @returns Validation result with errors and warnings
 */
export async function validateJavaScript(
  source: string,
  context: ValidationContext,
): Promise<ValidationResponse> {
  const mod = await getNativeModule();
  const contextJson = JSON.stringify(context);

  // Debug logging for crash investigation
  const debugValidation = process.env.DEBUG_VALIDATION === "1";
  if (debugValidation) {
    console.error(
      `[validateJavaScript] Starting validation for handler: ${context.handlerName}`,
    );
    console.error(
      `[validateJavaScript] Source length: ${source.length}, context length: ${contextJson.length}`,
    );
  }

  try {
    const result = await mod.validateJavascript(source, contextJson);
    if (debugValidation) {
      console.error(
        `[validateJavaScript] Got result, length: ${result.length}`,
      );
    }
    return JSON.parse(result) as ValidationResponse;
  } catch (err) {
    console.error(`[validateJavaScript] CRASH in native module: ${err}`);
    console.error(
      `[validateJavaScript] Source preview: ${source.slice(0, 200)}...`,
    );
    throw err;
  }
}

/**
 * Analyze a library tarball for security issues.
 *
 * Extracts and analyzes npm/GitHub tarballs in the isolated guest to detect:
 * - Malicious install scripts
 * - Suspicious dependencies
 * - Code patterns indicating supply chain attacks
 *
 * @param tgzBytes - Raw tarball bytes
 * @returns Analysis report
 */
export async function analyzeLibrary(
  tgzBytes: Buffer,
): Promise<Record<string, unknown>> {
  const mod = await getNativeModule();
  const result = await mod.analyzeLibrary(tgzBytes);
  return JSON.parse(result) as Record<string, unknown>;
}

// ── Re-export Types ───────────────────────────────────────────────────────

export type {
  ExportInfo,
  ModuleMetadataResponse,
  PluginConfigSchema,
  SchemaField,
  ScanFinding,
  ScanPluginResponse,
  ValidationContext,
  ValidationIssue,
  ValidationResponse,
};

// ── Shutdown ──────────────────────────────────────────────────────────────

/**
 * Shutdown the analysis runtime.
 *
 * This must be called before `process.exit()` to prevent SIGSEGV from
 * Rust TLS destructors racing with Node's exit handlers.
 *
 * After calling this, all analysis functions will fail.
 */
export async function shutdown(): Promise<void> {
  if (!nativeModule) return; // Nothing to shutdown if never loaded

  try {
    nativeModule.shutdown();
  } catch {
    // Best-effort — ignore errors during shutdown
  }
}
