// ── Plugin Schema Types ─────────────────────────────────────────────────
//
// Types for defining plugin configuration schemas in TypeScript.
// Plugins export a SCHEMA constant that defines their config structure.
// The Rust analysis guest extracts this at runtime (no dynamic import).
//
// ─────────────────────────────────────────────────────────────────────────

/**
 * Schema field definition for a single config property.
 * Drives interactive prompts during /plugin enable.
 */
export interface SchemaField {
  /** JSON-ish type hint for validation and prompt rendering. */
  type: "string" | "number" | "boolean" | "array";
  /** Human-readable description shown during config prompts. */
  description: string;
  /** Default value used when the user accepts the default. */
  default?: string | number | boolean | string[];
  /** Minimum value (for number type). */
  minimum?: number;
  /** Maximum value (for number type). */
  maximum?: number;
  /** Maximum string length (for string type). */
  maxLength?: number;
  /**
   * Whether the field is required (must have a non-empty value).
   * Fields with no default that are required will re-prompt until
   * the user provides a value.
   */
  required?: boolean;
  /**
   * Whether to include this field in interactive prompts.
   * Fields not marked as promptKey that have defaults are applied silently.
   */
  promptKey?: boolean;
  /** For array types, describes the element type. */
  items?: { type: string };
}

/**
 * A config schema is a record of field names to schema fields.
 * Plugins export this as `export const SCHEMA = {...} satisfies ConfigSchema`.
 */
export type ConfigSchema = Record<string, SchemaField>;

/**
 * Derive config values type from a schema.
 * Use as: `type MyConfig = ConfigValues<typeof SCHEMA>`
 */
export type ConfigValues<S extends ConfigSchema> = {
  [K in keyof S]?: S[K]["type"] extends "string"
    ? string
    : S[K]["type"] extends "number"
      ? number
      : S[K]["type"] extends "boolean"
        ? boolean
        : S[K]["type"] extends "array"
          ? string[]
          : never;
};
