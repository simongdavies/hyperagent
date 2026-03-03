// hyperlight-analysis - TypeScript type declarations
//
// Copyright 2026  The Hyperlight Authors. Licensed under Apache-2.0.

/**
 * Get the SHA256 hash of the embedded analysis runtime.
 * This can be used for audit logging.
 */
export function getRuntimeHash(): string;

/**
 * Get the size of the embedded analysis runtime in bytes.
 */
export function getRuntimeSize(): number;

/**
 * Shutdown the analysis runtime.
 *
 * This must be called before `process.exit()` to prevent SIGSEGV from
 * Rust TLS destructors racing with Node's exit handlers.
 *
 * After calling this, all analysis functions will fail.
 */
export function shutdown(): void;

/**
 * Ping the analysis guest to verify it's working.
 * @param input - Input string to echo
 * @returns JSON response: `{"pong":"<input>"}`
 */
export function ping(input: string): Promise<string>;

/**
 * Extract module metadata from JavaScript source code.
 *
 * Parses the source to extract:
 * - Export signatures (functions, classes, constants)
 * - JSDoc comments and type annotations
 * - `_HINTS` export for LLM guidance
 *
 * @param source - JavaScript ES module source code
 * @param configJson - Optional JSON configuration
 * @returns JSON string with extracted metadata
 */
export function extractModuleMetadata(
  source: string,
  configJson?: string,
): Promise<string>;

/**
 * Extract module metadata from a TypeScript declaration (.d.ts) file.
 *
 * Parses .d.ts files which have cleaner type information than JSDoc:
 * - `export declare function name(params): returnType;`
 * - `export interface Name { ... }`
 * - `export declare const name: Type;`
 *
 * @param source - TypeScript declaration file content
 * @param configJson - Optional JSON configuration
 * @returns JSON string with extracted metadata (same format as extractModuleMetadata)
 */
export function extractDtsMetadata(
  source: string,
  configJson?: string,
): Promise<string>;

/**
 * Scan plugin source code for security issues.
 *
 * Performs static analysis to detect:
 * - Dangerous patterns (eval, child_process, etc.)
 * - Suspicious code constructs
 * - Policy violations
 *
 * @param source - Plugin JavaScript source code
 * @param configJson - Optional JSON configuration
 * @returns JSON string with scan findings
 */
export function scanPlugin(
  source: string,
  configJson?: string,
): Promise<string>;

/**
 * Validate JavaScript source code for syntax errors and common issues.
 *
 * This is the primary tool for LLM code validation before handler registration.
 * Checks:
 * - Syntax errors (via QuickJS parser - same as runtime)
 * - Import specifier validity
 * - Named import existence
 * - Handler structure requirements
 * - QuickJS compatibility warnings
 *
 * @param source - JavaScript source code to validate
 * @param contextJson - JSON context with validation parameters
 * @returns JSON string with validation result
 */
export function validateJavascript(
  source: string,
  contextJson: string,
): Promise<string>;

/**
 * Analyze a library tarball for security issues.
 *
 * Extracts and analyzes npm/GitHub tarballs to detect:
 * - Malicious install scripts
 * - Suspicious dependencies
 * - Code patterns indicating supply chain attacks
 *
 * @param tgzBytes - Raw tarball bytes
 * @param configJson - Optional JSON configuration
 * @returns JSON string with analysis report
 */
export function analyzeLibrary(
  tgzBytes: Buffer,
  configJson?: string,
): Promise<string>;

// ── Response Types ──────────────────────────────────────────────

/** Response from ping() */
export interface PingResponse {
  message: string;
}

/** Export information extracted from module source */
export interface ExportInfo {
  name: string;
  kind: "function" | "class" | "const" | "let" | "var" | "default";
  signature?: string;
  description?: string;
  params?: Array<{
    name: string;
    type?: string;
    description?: string;
    /** Whether the parameter is required. Defaults to true.
     * Optional params use JSDoc syntax: @param {Type} [name] */
    required: boolean;
  }>;
  returns?: {
    type?: string;
    description?: string;
  };
  /** @requires tags - module/plugin dependencies (e.g. ["host:fs-write", "ha:zip-format"]). */
  requires?: string[];
}

/** Class information extracted from module source (Phase 4.5) */
export interface ClassInfo {
  /** Class name */
  name: string;
  /** Instance method names */
  methods: string[];
  /** Method return types: maps method name to return type name */
  methodReturns?: Record<string, string>;
  /** Instance property names */
  properties?: string[];
}

/** Response from extractModuleMetadata() */
export interface ModuleMetadataResponse {
  exports: ExportInfo[];
  hints?: string;
  /** Class definitions with their methods (Phase 4.5) */
  classes: ClassInfo[];
  issues: Array<{
    severity: "error" | "warning" | "info";
    message: string;
    line?: number;
  }>;
  /** Plugin config schema from SCHEMA export (when extractSchema=true in config). */
  schema?: PluginConfigSchema;
}

// ── Plugin Config Schema Types ─────────────────────────────────────────

/** Schema field definition for a single config property. */
export interface SchemaField {
  /** Field type: "string", "number", "boolean", "array". */
  type: "string" | "number" | "boolean" | "array";
  /** Human-readable description. */
  description: string;
  /** Default value (type depends on field type). */
  default?: string | number | boolean | string[];
  /** Minimum value (for number type). */
  minimum?: number;
  /** Maximum value (for number type). */
  maximum?: number;
  /** Maximum string length (for string type). */
  maxLength?: number;
  /** Whether the field is required. */
  required?: boolean;
  /** Whether to include in interactive prompts. */
  promptKey?: boolean;
  /** For array types, element type info. */
  items?: { type: string };
}

/** Plugin config schema - map of field name to field definition. */
export type PluginConfigSchema = Record<string, SchemaField>;

/** Finding from plugin scan */
export interface ScanFinding {
  severity: "danger" | "warning" | "info";
  message: string;
  line?: number;
  column?: number;
}

/** Response from scanPlugin() */
export interface ScanPluginResponse {
  findings: ScanFinding[];
  source_size: number;
}

/** Validation error or warning */
export interface ValidationIssue {
  type:
    | "syntax"
    | "import"
    | "conflict"
    | "structure"
    | "compatibility"
    | "method"
    | "parameter";
  message: string;
  line?: number;
  column?: number;
}

/** Response from validateJavascript() */
export interface ValidationResponse {
  valid: boolean;
  /** Whether the code uses ES module syntax (import/export). */
  isModule: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /** All import specifiers found (handler + transitive from provided modules). */
  imports: string[];
  /** Whether deep validation was performed.
   * false if there are unresolved imports - host should provide more sources and retry. */
  deepValidationDone: boolean;
  /** Import specifiers missing from moduleSources.
   * Host should resolve these and call again. */
  missingSources: string[];
}

/** Validation context input */
export interface ValidationContext {
  handlerName: string;
  registeredHandlers?: string[];
  availableModules?: string[];
  expectHandler?: boolean;
  /**
   * Module sources for deep validation.
   * Keys are import specifiers (e.g., "ha:pptx", "host:fs-write").
   * Values are the actual JavaScript source code.
   * When provided, the validator loads these modules into QuickJS
   * and catches runtime errors like "not a function".
   */
  moduleSources?: Record<string, string>;
  /**
   * TypeScript declaration (.d.ts) sources for metadata extraction.
   * Keys are import specifiers (e.g., "ha:pptx").
   * When present, metadata is extracted from .d.ts (cleaner types)
   * instead of .js JSDoc.
   */
  dtsSources?: Record<string, string>;
  /**
   * Module JSON metadata (module.json content) for system modules.
   * Keys are import specifiers. Values are JSON strings containing
   * name, description, author, mutable, sourceHash, dtsHash.
   * Presence indicates a system module.
   */
  moduleJsons?: Record<string, string>;
  /**
   * Module metadata for deep method validation (Phase 4.5).
   * Keys are import specifiers (e.g., "ha:pptx").
   * Values contain export info and class definitions.
   * Used to validate method calls against known class methods.
   * @deprecated Use dtsSources/moduleSources instead - validator will extract metadata.
   */
  moduleMetadata?: Record<string, ModuleMetadataForValidation>;
}

/** Condensed module metadata for validation (Phase 4.5) */
export interface ModuleMetadataForValidation {
  /** Export summaries with return type info */
  exports: ExportSummary[];
  /** Class definitions with their methods */
  classes: Record<string, ClassSummary>;
}

/** Export summary for validation */
export interface ExportSummary {
  name: string;
  kind: string;
  returnsType?: string;
  /** Function parameters with required/optional info (Phase 4.5.2) */
  params?: ParamSummary[];
}

/** Parameter summary for validation (Phase 4.5.2) */
export interface ParamSummary {
  name: string;
  paramType?: string;
  /** Whether the parameter is required. Defaults to true. */
  required: boolean;
}

/** Class summary for validation */
export interface ClassSummary {
  methods: string[];
}
