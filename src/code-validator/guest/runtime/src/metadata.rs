/*
Copyright 2026  The Hyperlight Authors.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

//! Module metadata extraction.
//!
//! Extracts exports, JSDoc documentation, and _HINTS from JavaScript modules.
//! Uses regex-automata for ReDoS-safe linear-time pattern matching.

extern crate alloc;

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

/// Information about a single exported symbol.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportInfo {
    /// Symbol name (e.g., "crc32", "strToBytes").
    pub name: String,
    /// Kind of export: "function", "const", "class", "unknown".
    pub kind: String,
    /// Human-readable signature (e.g., "crc32(data: Uint8Array): number").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    /// First line of JSDoc or @description, if present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// @param tags extracted from JSDoc.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Vec<ParamInfo>>,
    /// @returns tag extracted from JSDoc.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub returns: Option<ReturnsInfo>,
    /// @requires tags - module/plugin dependencies.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires: Option<Vec<String>>,
}

/// Parameter information from JSDoc.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamInfo {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "type")]
    pub param_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Whether the parameter is required. Defaults to true.
    /// Optional params use JSDoc syntax: @param {Type} [name] - description
    #[serde(default = "default_true")]
    pub required: bool,
}

/// Return value information from JSDoc.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReturnsInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "type")]
    pub return_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Information about a class and its methods.
/// Used for deep validation of method calls and property access.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassInfo {
    /// Class name.
    pub name: String,
    /// Instance method names.
    pub methods: Vec<String>,
    /// Method return types (Phase 4.5.4): maps method name → return type name.
    #[serde(
        default,
        skip_serializing_if = "alloc::collections::BTreeMap::is_empty"
    )]
    pub method_returns: alloc::collections::BTreeMap<String, String>,
    /// Instance property names (for property access validation).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub properties: Vec<String>,
}

/// Issue found during metadata extraction.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetadataIssue {
    /// Severity: "error", "warning", "info".
    pub severity: String,
    /// Human-readable message.
    pub message: String,
    /// Line number (1-indexed), if applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
}

// ── Plugin Schema Types ──────────────────────────────────────────────────
// These mirror the TypeScript types in plugin-schema-types.ts.
// Plugins export `const SCHEMA = {...} satisfies ConfigSchema`.

/// A single field in a plugin config schema.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaField {
    /// Field type: "string", "number", "boolean", "array".
    #[serde(rename = "type")]
    pub field_type: String,
    /// Human-readable description.
    pub description: String,
    /// Default value (type depends on field_type).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<serde_json::Value>,
    /// Minimum value (for number type).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimum: Option<f64>,
    /// Maximum value (for number type).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maximum: Option<f64>,
    /// Maximum string length (for string type).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_length: Option<u32>,
    /// Whether the field is required.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    /// Whether to include in interactive prompts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_key: Option<bool>,
    /// For array types, element type info.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<SchemaItems>,
}

/// Items descriptor for array-type schema fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaItems {
    #[serde(rename = "type")]
    pub item_type: String,
}

/// Plugin config schema - map of field name to field definition.
pub type ConfigSchema = alloc::collections::BTreeMap<String, SchemaField>;

/// Result of module metadata extraction.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleMetadataResult {
    /// Extracted exports with documentation.
    pub exports: Vec<ExportInfo>,
    /// Module-specific hints from _HINTS export.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hints: Option<String>,
    /// Issues found during extraction.
    pub issues: Vec<MetadataIssue>,
    /// Class definitions with their methods (for deep validation).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub classes: Vec<ClassInfo>,
    /// Plugin config schema from SCHEMA export.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<ConfigSchema>,
}

/// Configuration for metadata extraction.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataConfig {
    /// Whether to extract JSDoc comments.
    #[serde(default = "default_true")]
    pub extract_jsdoc: bool,
    /// Whether to extract _HINTS export.
    #[serde(default = "default_true")]
    pub extract_hints: bool,
    /// Whether to extract SCHEMA export (for plugins).
    #[serde(default)]
    pub extract_schema: bool,
}

fn default_true() -> bool {
    true
}

/// Extract metadata from JavaScript module source.
///
/// This is the main entry point for module metadata extraction.
/// Uses line-by-line parsing and simple patterns to avoid ReDoS.
pub fn extract_module_metadata(source: &str, config: &MetadataConfig) -> ModuleMetadataResult {
    let mut exports = Vec::new();
    let issues = Vec::new();
    let mut hints = None;
    let mut schema = None;

    let lines: Vec<&str> = source.lines().collect();
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i].trim();

        // Check for JSDoc block start
        if line.starts_with("/**") {
            let mut jsdoc_lines = Vec::new();

            // Collect JSDoc lines until we hit */
            while i < lines.len() {
                let jline = lines[i];
                jsdoc_lines.push(jline);
                if jline.contains("*/") {
                    break;
                }
                i += 1;
            }
            i += 1;

            // Check if next non-empty line is an export
            while i < lines.len() && lines[i].trim().is_empty() {
                i += 1;
            }

            if i < lines.len() {
                let export_line = lines[i].trim();
                if let Some(export) = parse_export_line(export_line, &jsdoc_lines) {
                    exports.push(export);
                }
            }
            continue;
        }

        // Check for exports without JSDoc
        if line.starts_with("export ")
            && let Some(export) = parse_export_line(line, &[])
        {
            // Don't duplicate if we already have it from JSDoc pass
            if !exports.iter().any(|e| e.name == export.name) {
                exports.push(export);
            }
        }

        // Check for _HINTS export
        if line.contains("export") && line.contains("_HINTS") {
            hints = extract_hints_value(source, i);
        }

        // Check for SCHEMA export (for plugins)
        if config.extract_schema
            && line.contains("export")
            && line.contains("SCHEMA")
            && line.contains("const")
        {
            schema = extract_schema_value(source, i);
        }

        i += 1;
    }

    // Check for export list at end: export { a, b, c }
    for line in &lines {
        let trimmed = line.trim();
        if trimmed.starts_with("export {") || trimmed.starts_with("export{") {
            let list_exports = parse_export_list(trimmed);
            for name in list_exports {
                if !exports.iter().any(|e| e.name == name) {
                    exports.push(ExportInfo {
                        name,
                        kind: "unknown".to_string(),
                        signature: None,
                        description: None,
                        params: None,
                        returns: None,
                        requires: None,
                    });
                }
            }
        }
    }

    // Extract class definitions with their methods
    let classes = extract_classes(source);

    ModuleMetadataResult {
        exports,
        hints,
        issues,
        classes,
        schema,
    }
}

/// Extract metadata from a TypeScript declaration (.d.ts) file.
///
/// This parses .d.ts files which have cleaner type information than JSDoc.
/// Patterns supported:
/// - `export declare function name(params): returnType;`
/// - `export interface Name { ... }`
/// - `export declare const name: Type;`
/// - `export declare class Name { ... }`
pub fn extract_dts_metadata(source: &str, _config: &MetadataConfig) -> ModuleMetadataResult {
    let mut exports = Vec::new();
    let issues = Vec::new();
    let mut classes = Vec::new();

    let lines: Vec<&str> = source.lines().collect();
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i].trim();

        // Check for JSDoc block start (these are preserved in .d.ts)
        if line.starts_with("/**") {
            let mut jsdoc_lines = Vec::new();

            // Collect JSDoc lines until we hit */
            while i < lines.len() {
                let jline = lines[i];
                jsdoc_lines.push(jline);
                if jline.contains("*/") {
                    break;
                }
                i += 1;
            }
            i += 1;

            // Check if next non-empty line is an export declaration
            while i < lines.len() && lines[i].trim().is_empty() {
                i += 1;
            }

            if i < lines.len() {
                let decl_line = lines[i].trim();

                // Handle multi-line function declarations (e.g., shapes() with complex type params)
                if is_multiline_function_start(decl_line) {
                    let (full_decl, next_i) = collect_multiline_function(&lines, i);
                    if let Some(export) = parse_dts_declaration(&full_decl, &jsdoc_lines) {
                        exports.push(export);
                    }
                    i = next_i;
                    continue;
                }

                if let Some(export) = parse_dts_declaration(decl_line, &jsdoc_lines) {
                    exports.push(export);
                } else if let Some(class) = parse_dts_interface_or_class(decl_line, &lines, i) {
                    classes.push(class.0);
                    i = class.1; // Skip to end of interface/class
                }
            }
            continue;
        }

        // Check for export declarations without JSDoc
        if line.starts_with("export ") {
            // Handle multi-line function declarations (e.g., shapes() with complex type params)
            if is_multiline_function_start(line) {
                let (full_decl, next_i) = collect_multiline_function(&lines, i);
                if let Some(export) = parse_dts_declaration(&full_decl, &[]) {
                    if !exports.iter().any(|e| e.name == export.name) {
                        exports.push(export);
                    }
                }
                i = next_i;
                continue;
            }

            if let Some(export) = parse_dts_declaration(line, &[]) {
                // Don't duplicate if we already have it from JSDoc pass
                if !exports.iter().any(|e| e.name == export.name) {
                    exports.push(export);
                }
            } else if let Some(class) = parse_dts_interface_or_class(line, &lines, i) {
                if !classes.iter().any(|c| c.name == class.0.name) {
                    classes.push(class.0);
                }
                i = class.1; // Skip to end of interface/class
                continue;
            }
        }

        i += 1;
    }

    // Handle re-exports: export { a, b, c } from "module";
    // These are valid exports that should be included
    for line in &lines {
        let trimmed = line.trim();
        // Pattern: export { ... } from "...";
        if trimmed.starts_with("export {") && trimmed.contains(" from ") {
            let list_exports = parse_export_list(trimmed);
            for name in list_exports {
                if !exports.iter().any(|e| e.name == name) {
                    exports.push(ExportInfo {
                        name,
                        kind: "reexport".to_string(),
                        signature: None,
                        description: None,
                        params: None,
                        returns: None,
                        requires: None,
                    });
                }
            }
        }
    }

    ModuleMetadataResult {
        exports,
        hints: None, // .d.ts files don't have _HINTS
        issues,
        classes,
        schema: None, // .d.ts files don't have SCHEMA
    }
}

/// Parse a .d.ts declaration line (function, const, type).
/// For multi-line declarations, pass all lines joined with spaces.
fn parse_dts_declaration(line: &str, jsdoc_lines: &[&str]) -> Option<ExportInfo> {
    let jsdoc = if jsdoc_lines.is_empty() {
        None
    } else {
        Some(parse_jsdoc(jsdoc_lines))
    };

    // Check for const BEFORE function - const values may contain the word "function"
    // e.g. `export declare const _HINTS = "...functions..."`
    // export declare const name: Type;
    if line.contains("declare") && line.contains("const ") {
        return parse_dts_const(line, jsdoc);
    }

    // export declare function name(params): returnType;
    if line.contains("declare") && line.contains("function") {
        return parse_dts_function(line, jsdoc);
    }

    None
}

/// Check if a line is a multi-line function start (has `function` and `(` but no closing paren on same line).
/// Returns true if we need to collect more lines.
fn is_multiline_function_start(line: &str) -> bool {
    if !line.contains("declare") || !line.contains("function") || line.contains("const ") {
        return false;
    }
    // Count parens - if open > close, it's multi-line
    let opens = line.matches('(').count();
    let closes = line.matches(')').count();
    opens > closes
}

/// Collect a multi-line function declaration starting at `start_idx`.
/// Returns (full_declaration, next_line_index).
fn collect_multiline_function(lines: &[&str], start_idx: usize) -> (String, usize) {
    let mut collected = String::new();
    let mut idx = start_idx;
    let mut paren_depth = 0i32;
    let mut found_open = false;

    while idx < lines.len() {
        let line = lines[idx].trim();
        if !collected.is_empty() {
            collected.push(' ');
        }
        collected.push_str(line);

        // Track paren depth
        for ch in line.chars() {
            if ch == '(' {
                paren_depth += 1;
                found_open = true;
            } else if ch == ')' {
                paren_depth -= 1;
            }
        }

        idx += 1;

        // When parens balance and we've seen at least one open, we're done
        // Also check for semicolon which ends the declaration
        if found_open && paren_depth == 0 && line.ends_with(';') {
            break;
        }
    }

    (collected, idx)
}

/// Parse .d.ts function declaration.
/// Pattern: export declare function name(params): returnType;
fn parse_dts_function(line: &str, jsdoc: Option<JsDocInfo>) -> Option<ExportInfo> {
    let line = line.trim();

    // Find "function" keyword
    let func_pos = line.find("function")?;
    let after_func = &line[func_pos + 8..].trim_start();

    // Extract name (up to '(')
    let paren_pos = after_func.find('(')?;
    let name = after_func[..paren_pos].trim().to_string();
    if name.is_empty() {
        return None;
    }

    // Extract parameter list
    let close_paren = after_func.find(')')?;
    let params_str = &after_func[paren_pos + 1..close_paren];

    // Extract return type (after ): and before ;)
    let after_paren = &after_func[close_paren + 1..];
    let return_type = if let Some(colon_pos) = after_paren.find(':') {
        let ret = after_paren[colon_pos + 1..].trim();
        let ret = ret.trim_end_matches(';').trim();
        if !ret.is_empty() {
            Some(ret.to_string())
        } else {
            None
        }
    } else {
        None
    };

    // Build signature: name(params): returnType
    let signature = if let Some(ref ret) = return_type {
        format!("{}({}): {}", name, params_str, ret)
    } else {
        format!("{}({})", name, params_str)
    };

    // Parse parameters from TypeScript syntax
    let params = parse_ts_params(params_str, jsdoc.as_ref());

    // Get description from JSDoc
    let description = jsdoc.as_ref().and_then(|j| j.description.clone());

    // Use return type from TypeScript, or fall back to JSDoc
    let returns = return_type
        .map(|t| ReturnsInfo {
            return_type: Some(t),
            description: jsdoc
                .as_ref()
                .and_then(|j| j.returns.as_ref().and_then(|r| r.description.clone())),
        })
        .or_else(|| jsdoc.and_then(|j| j.returns));

    Some(ExportInfo {
        name,
        kind: "function".to_string(),
        signature: Some(signature),
        description,
        params: if params.is_empty() {
            None
        } else {
            Some(params)
        },
        returns,
        requires: None,
    })
}

/// Parse .d.ts const declaration.
/// Pattern: export declare const name: Type; OR export declare const name = value;
fn parse_dts_const(line: &str, jsdoc: Option<JsDocInfo>) -> Option<ExportInfo> {
    let line = line.trim();

    // Find "const" keyword
    let const_pos = line.find("const ")?;
    let after_const = &line[const_pos + 6..].trim_start();

    // Extract name (up to ':', '=', or ';')
    // Must handle both `const FOO: Type` and `const FOO = "value"` patterns
    let colon_pos = after_const.find(':');
    let eq_pos = after_const.find('=');
    let semi_pos = after_const.find(';');

    // Name ends at the first delimiter found
    let name_end = [colon_pos, eq_pos, semi_pos]
        .iter()
        .filter_map(|&p| p)
        .min()
        .unwrap_or(after_const.len());
    let name = after_const[..name_end].trim().to_string();
    if name.is_empty() {
        return None;
    }

    // Extract type
    let type_str = if let Some(pos) = colon_pos {
        let t = &after_const[pos + 1..];
        let t = t.trim_end_matches(';').trim();
        if !t.is_empty() {
            Some(t.to_string())
        } else {
            None
        }
    } else {
        None
    };

    let signature = if let Some(ref t) = type_str {
        format!("{}: {}", name, t)
    } else {
        name.clone()
    };

    Some(ExportInfo {
        name,
        kind: "const".to_string(),
        signature: Some(signature),
        description: jsdoc.and_then(|j| j.description),
        params: None,
        returns: None,
        requires: None,
    })
}

/// Parse TypeScript parameter syntax.
/// Example: "s: string, opts?: Options"
fn parse_ts_params(params_str: &str, jsdoc: Option<&JsDocInfo>) -> Vec<ParamInfo> {
    let mut params = Vec::new();

    if params_str.trim().is_empty() {
        return params;
    }

    // Split by comma, but handle nested generics
    let param_parts = split_ts_params(params_str);

    for part in param_parts {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }

        // Handle rest parameters: ...arrays: Uint8Array[]
        let (part, is_rest) = if part.starts_with("...") {
            (&part[3..], true)
        } else {
            (part, false)
        };

        // Check for optional parameter: name?: Type
        let is_optional = part.contains("?:");

        // Split by ':' to get name and type
        let (name, param_type) = if let Some(colon_pos) = part.find(':') {
            let n = part[..colon_pos].trim().trim_end_matches('?');
            let t = part[colon_pos + 1..].trim();
            (
                n.to_string(),
                if t.is_empty() {
                    None
                } else {
                    Some(t.to_string())
                },
            )
        } else {
            (part.trim().to_string(), None)
        };

        // Get description from JSDoc if available
        let description = jsdoc.and_then(|j| {
            j.params
                .iter()
                .find(|p| p.name == name)
                .and_then(|p| p.description.clone())
        });

        let display_name = if is_rest {
            format!("...{}", name)
        } else {
            name.clone()
        };

        params.push(ParamInfo {
            name: display_name,
            param_type,
            description,
            required: !is_optional,
        });
    }

    params
}

/// Split TypeScript parameters by comma, handling nested generics.
fn split_ts_params(s: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth: i32 = 0;
    let mut start = 0;

    for (i, c) in s.char_indices() {
        match c {
            '<' | '(' | '{' | '[' => depth += 1,
            '>' | ')' | '}' | ']' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                parts.push(&s[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }

    if start < s.len() {
        parts.push(&s[start..]);
    }

    parts
}

/// Parse .d.ts interface or class declaration.
/// Returns (ClassInfo, end_line_index).
fn parse_dts_interface_or_class(
    line: &str,
    lines: &[&str],
    start_idx: usize,
) -> Option<(ClassInfo, usize)> {
    let line = line.trim();

    // export interface Name { or export declare class Name {
    let is_interface = line.contains("interface ");
    let is_class = line.contains("class ");

    if !is_interface && !is_class {
        return None;
    }

    // Extract name
    let keyword = if is_interface { "interface " } else { "class " };
    let keyword_pos = line.find(keyword)?;
    let after_keyword = &line[keyword_pos + keyword.len()..];

    // Name ends at '{', '<', or whitespace
    let name_end = after_keyword
        .find(|c: char| c == '{' || c == '<' || c.is_whitespace())
        .unwrap_or(after_keyword.len());
    let name = after_keyword[..name_end].trim().to_string();

    if name.is_empty() {
        return None;
    }

    let mut methods = Vec::new();
    let mut properties = Vec::new();
    let mut method_returns = alloc::collections::BTreeMap::new();
    let mut i = start_idx + 1;

    // Parse body until closing brace
    let mut brace_depth = 1; // We're inside the opening brace
    if !line.contains('{') {
        // Opening brace might be on next line
        while i < lines.len() && !lines[i].contains('{') {
            i += 1;
        }
        if i < lines.len() {
            i += 1;
        }
    }

    while i < lines.len() && brace_depth > 0 {
        let member_line = lines[i].trim();

        // Track brace depth
        for c in member_line.chars() {
            match c {
                '{' => brace_depth += 1,
                '}' => brace_depth -= 1,
                _ => {}
            }
        }

        // Skip empty lines and closing braces
        if member_line.is_empty() || member_line == "}" {
            i += 1;
            continue;
        }

        // Parse method: name(params): returnType;
        if member_line.contains('(') && member_line.contains(')') && !member_line.starts_with("//")
        {
            if let Some((method_name, ret_type)) = parse_interface_method(member_line) {
                if !method_name.starts_with('_') {
                    methods.push(method_name.clone());
                    if let Some(rt) = ret_type {
                        method_returns.insert(method_name, rt);
                    }
                }
            }
        }
        // Parse property: name: Type;
        else if member_line.contains(':') && !member_line.starts_with("//") {
            if let Some(prop_name) = parse_interface_property(member_line) {
                if !prop_name.starts_with('_') {
                    properties.push(prop_name);
                }
            }
        }

        i += 1;
    }

    Some((
        ClassInfo {
            name,
            methods,
            method_returns,
            properties,
        },
        i,
    ))
}

/// Parse interface method declaration.
/// Pattern: name(params): returnType;
/// Returns (method_name, return_type).
fn parse_interface_method(line: &str) -> Option<(String, Option<String>)> {
    let line = line.trim();

    // Skip readonly, optional markers
    let line = line.trim_start_matches("readonly ");

    // Extract method name (before '(')
    let paren_pos = line.find('(')?;
    let name = line[..paren_pos].trim().trim_end_matches('?').to_string();

    if name.is_empty() || name.contains(':') {
        return None;
    }

    // Extract return type (after ):)
    let close_paren = line.find(')')?;
    let after_paren = &line[close_paren + 1..];

    let return_type = if let Some(colon_pos) = after_paren.find(':') {
        let ret = after_paren[colon_pos + 1..].trim();
        let ret = ret.trim_end_matches(';').trim();
        if !ret.is_empty() {
            Some(ret.to_string())
        } else {
            None
        }
    } else {
        None
    };

    Some((name, return_type))
}

/// Parse interface property declaration.
/// Pattern: name: Type;
fn parse_interface_property(line: &str) -> Option<String> {
    let line = line.trim();

    // Skip readonly marker
    let line = line.trim_start_matches("readonly ");

    // Skip if it's a method (has parentheses before colon)
    if let Some(paren_pos) = line.find('(') {
        if let Some(colon_pos) = line.find(':') {
            if paren_pos < colon_pos {
                return None;
            }
        }
    }

    // Extract property name (before ':' or '?:')
    let colon_pos = line.find(':')?;
    let name = line[..colon_pos].trim().trim_end_matches('?').to_string();

    if name.is_empty() || name.contains('(') {
        return None;
    }

    Some(name)
}

/// Parse an export declaration line.
fn parse_export_line(line: &str, jsdoc_lines: &[&str]) -> Option<ExportInfo> {
    let jsdoc = if jsdoc_lines.is_empty() {
        None
    } else {
        Some(parse_jsdoc(jsdoc_lines))
    };

    // export function name(params)
    if line.contains("export") && line.contains("function") {
        return parse_export_function(line, jsdoc);
    }

    // export const/let/var name
    if line.contains("export")
        && (line.contains("const ") || line.contains("let ") || line.contains("var "))
    {
        return parse_export_const(line, jsdoc);
    }

    // export class name
    if line.contains("export") && line.contains("class ") {
        return parse_export_class(line, jsdoc);
    }

    None
}

/// Parse export function declaration.
fn parse_export_function(line: &str, jsdoc: Option<JsDocInfo>) -> Option<ExportInfo> {
    // Pattern: export function name(params)
    // or: export async function name(params)
    let line = line.trim();

    // Find "function" keyword
    let func_pos = line.find("function")?;
    let after_func = &line[func_pos + 8..].trim_start();

    // Extract name (up to '(')
    let paren_pos = after_func.find('(')?;
    let name = after_func[..paren_pos].trim().to_string();
    if name.is_empty() {
        return None;
    }

    // Extract params (between first '(' and matching ')')
    let params_str = extract_balanced(&after_func[paren_pos..], '(', ')')?;

    // Build signature from JSDoc if available
    let (signature, params, returns) = if let Some(ref jsdoc) = jsdoc {
        let typed_params = if jsdoc.params.is_empty() {
            params_str.to_string()
        } else {
            jsdoc
                .params
                .iter()
                .map(|p| {
                    if let Some(ref t) = p.param_type {
                        alloc::format!("{}: {}", p.name, t)
                    } else {
                        p.name.clone()
                    }
                })
                .collect::<Vec<_>>()
                .join(", ")
        };
        let ret_type = jsdoc
            .returns
            .as_ref()
            .and_then(|r| r.return_type.as_ref())
            .map(|t| alloc::format!(": {}", t))
            .unwrap_or_default();
        let sig = alloc::format!("{}({}){}", name, typed_params, ret_type);
        (
            Some(sig),
            if jsdoc.params.is_empty() {
                None
            } else {
                Some(jsdoc.params.clone())
            },
            jsdoc.returns.clone(),
        )
    } else {
        (Some(alloc::format!("{}({})", name, params_str)), None, None)
    };

    Some(ExportInfo {
        name,
        kind: "function".to_string(),
        signature,
        description: jsdoc.as_ref().and_then(|j| j.description.clone()),
        params,
        returns,
        requires: jsdoc.and_then(|j| {
            if j.requires.is_empty() {
                None
            } else {
                Some(j.requires)
            }
        }),
    })
}

/// Parse export const/let/var declaration.
fn parse_export_const(line: &str, jsdoc: Option<JsDocInfo>) -> Option<ExportInfo> {
    // Pattern: export const name = ...
    let line = line.trim();

    // Find const/let/var keyword
    let keyword = if line.contains("const ") {
        "const"
    } else if line.contains("let ") {
        "let"
    } else {
        "var"
    };

    let kw_pos = line.find(keyword)?;
    let after_kw = &line[kw_pos + keyword.len()..].trim_start();

    // Extract name (up to '=' or end of identifier)
    let name_end = after_kw
        .find(|c: char| c == '=' || c == ':' || c.is_whitespace())
        .unwrap_or(after_kw.len());
    let name = after_kw[..name_end].trim().to_string();
    if name.is_empty() {
        return None;
    }

    // Extract type annotation if present
    let type_str = jsdoc
        .as_ref()
        .and_then(|j| j.type_annotation.clone())
        .map(|t| alloc::format!(": {}", t));

    let signature = Some(alloc::format!("{}{}", name, type_str.unwrap_or_default()));

    Some(ExportInfo {
        name,
        kind: "const".to_string(),
        signature,
        description: jsdoc.as_ref().and_then(|j| j.description.clone()),
        params: None,
        returns: None,
        requires: jsdoc.and_then(|j| {
            if j.requires.is_empty() {
                None
            } else {
                Some(j.requires)
            }
        }),
    })
}

/// Parse export class declaration.
fn parse_export_class(line: &str, jsdoc: Option<JsDocInfo>) -> Option<ExportInfo> {
    // Pattern: export class Name
    let line = line.trim();

    let class_pos = line.find("class ")?;
    let after_class = &line[class_pos + 6..].trim_start();

    // Extract name (up to '{' or 'extends' or whitespace)
    let name_end = after_class.find(['{', ' ']).unwrap_or(after_class.len());
    let name = after_class[..name_end].trim().to_string();
    if name.is_empty() {
        return None;
    }

    Some(ExportInfo {
        name: name.clone(),
        kind: "class".to_string(),
        signature: Some(alloc::format!("class {}", name)),
        description: jsdoc.as_ref().and_then(|j| j.description.clone()),
        params: None,
        returns: None,
        requires: None,
    })
}

/// Parse export { a, b, c } list.
fn parse_export_list(line: &str) -> Vec<String> {
    let mut names = Vec::new();

    // Find content between { and }
    if let Some(start) = line.find('{')
        && let Some(end) = line.find('}')
    {
        let content = &line[start + 1..end];
        for item in content.split(',') {
            let item = item.trim();
            // Handle "name as alias" - take original name
            let name = item.split_whitespace().next().unwrap_or(item);
            if !name.is_empty() && name != "as" {
                names.push(name.to_string());
            }
        }
    }

    names
}

/// Extract class definitions with their methods from source.
/// This enables deep validation of method calls.
fn extract_classes(source: &str) -> Vec<ClassInfo> {
    let mut classes = Vec::new();
    let lines: Vec<&str> = source.lines().collect();

    for (line_idx, line) in lines.iter().enumerate() {
        let trimmed = line.trim();

        // Look for class declarations (exported or not)
        if trimmed.contains("class ") {
            // Extract class name
            let class_pos = match trimmed.find("class ") {
                Some(p) => p,
                None => continue,
            };
            let after_class = &trimmed[class_pos + 6..].trim_start();

            // Extract name (up to '{', 'extends', or whitespace)
            let name_end = after_class.find(['{', ' ']).unwrap_or(after_class.len());
            let class_name = after_class[..name_end].trim().to_string();
            if class_name.is_empty() {
                continue;
            }

            // Extract methods and properties from class body
            let (methods, method_returns, properties) = extract_class_members(&lines, line_idx);

            classes.push(ClassInfo {
                name: class_name,
                methods,
                method_returns,
                properties,
            });
        }
    }

    classes
}

/// Extract method names, return types, and properties from a class body.
/// Returns (methods, method_returns, properties).
fn extract_class_members(
    lines: &[&str],
    class_line: usize,
) -> (
    Vec<String>,
    alloc::collections::BTreeMap<String, String>,
    Vec<String>,
) {
    let mut methods = Vec::new();
    let mut properties = Vec::new();
    let mut method_returns: alloc::collections::BTreeMap<String, String> =
        alloc::collections::BTreeMap::new();
    let mut depth: i32 = 0;
    let mut in_class = false;
    let mut in_constructor = false;
    let mut constructor_depth = 0;
    let mut pending_jsdoc: Option<Vec<&str>> = None;
    let mut collecting_jsdoc = false;

    for (i, line) in lines.iter().skip(class_line).enumerate() {
        let trimmed = line.trim();

        // Handle JSDoc collection
        if trimmed.starts_with("/**") {
            pending_jsdoc = Some(alloc::vec![*line]);
            collecting_jsdoc = !trimmed.contains("*/"); // Multi-line JSDoc if no closing */
            continue;
        } else if collecting_jsdoc {
            if let Some(ref mut jsdoc) = pending_jsdoc {
                jsdoc.push(*line);
            }
            if trimmed.contains("*/") {
                collecting_jsdoc = false;
            }
            continue;
        }

        // Count braces to track depth
        let opens = trimmed.matches('{').count();
        let closes = trimmed.matches('}').count();

        // Enter class on first '{'
        if !in_class && opens > 0 {
            depth = opens as i32 - closes as i32;
            in_class = true;
            pending_jsdoc = None;
            continue;
        }

        if !in_class {
            pending_jsdoc = None;
            continue;
        }

        // Track constructor for this.propName extraction
        if depth == 1 && trimmed.starts_with("constructor(") {
            in_constructor = true;
            constructor_depth = depth + opens as i32 - closes as i32;
        }

        // Extract this.propName = ... assignments in constructor
        if in_constructor && depth >= constructor_depth {
            if let Some(prop_name) = extract_this_assignment(trimmed) {
                if !prop_name.starts_with('_') && !properties.contains(&prop_name) {
                    properties.push(prop_name);
                }
            }
        }

        // Look for method definitions at depth 1 (direct class members)
        if depth == 1
            && let Some(method_name) = parse_method_definition(trimmed)
            && method_name != "constructor"
            && !method_name.starts_with('_')
            && !methods.contains(&method_name)
        {
            methods.push(method_name.clone());

            // Extract return type from JSDoc if present
            if let Some(ref jsdoc_lines) = pending_jsdoc {
                if let Some(return_type) = extract_jsdoc_return_type(jsdoc_lines) {
                    method_returns.insert(method_name, return_type);
                }
            }
            pending_jsdoc = None;
        }

        // Look for class field declarations at depth 1: propName = value;
        if depth == 1 && parse_method_definition(trimmed).is_none() {
            if let Some(prop_name) = extract_class_field(trimmed) {
                if !prop_name.starts_with('_') && !properties.contains(&prop_name) {
                    properties.push(prop_name);
                }
            }
        }

        // Clear pending JSDoc if we hit a non-method line at depth 1
        if depth == 1
            && !trimmed.starts_with("/**")
            && !trimmed.is_empty()
            && !trimmed.starts_with("//")
        {
            if parse_method_definition(trimmed).is_none() {
                pending_jsdoc = None;
            }
        }

        // Update depth
        depth += opens as i32;
        depth -= closes as i32;

        // Track exiting constructor
        if in_constructor && depth < constructor_depth {
            in_constructor = false;
        }

        // Class ended
        if depth <= 0 {
            break;
        }

        // Safety: don't scan more than 1000 lines of a class
        if i > 1000 {
            break;
        }
    }

    (methods, method_returns, properties)
}

/// Extract property name from `this.propName = ...` assignments.
fn extract_this_assignment(line: &str) -> Option<String> {
    let trimmed = line.trim();

    // Pattern: this.propName = ...
    let after_this = trimmed.strip_prefix("this.")?;

    // Find the property name (up to = or ;)
    let name_end = after_this.find(|c: char| c == '=' || c == ';' || c.is_whitespace())?;
    let prop_name = &after_this[..name_end];

    // Validate it looks like an identifier
    if prop_name.is_empty() {
        return None;
    }

    let first_char = prop_name.chars().next()?;
    if !first_char.is_alphabetic() && first_char != '_' {
        return None;
    }

    if !prop_name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return None;
    }

    Some(prop_name.to_string())
}

/// Extract property name from class field declarations like `propName = value;`.
fn extract_class_field(line: &str) -> Option<String> {
    let trimmed = line.trim();

    // Skip lines that don't look like field declarations
    if trimmed.is_empty()
        || trimmed.starts_with("//")
        || trimmed.starts_with("/*")
        || trimmed.starts_with('*')
        || trimmed.starts_with('#')  // private fields
        || trimmed.starts_with("static ")
        || trimmed.starts_with("async ")
        || trimmed.starts_with("get ")
        || trimmed.starts_with("set ")
    {
        return None;
    }

    // Must contain = but not start with function-like syntax
    if !trimmed.contains('=') {
        return None;
    }

    // Must not contain ( before = (would be a method or arrow function)
    let eq_pos = trimmed.find('=')?;
    let before_eq = &trimmed[..eq_pos];
    if before_eq.contains('(') {
        return None;
    }

    // Extract the identifier
    let prop_name = before_eq.trim();

    // Validate it looks like an identifier
    if prop_name.is_empty() {
        return None;
    }

    let first_char = prop_name.chars().next()?;
    if !first_char.is_alphabetic() && first_char != '_' {
        return None;
    }

    if !prop_name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return None;
    }

    Some(prop_name.to_string())
}

/// Extract return type from JSDoc lines.
/// Looks for @returns {Type} or @return {Type}.
fn extract_jsdoc_return_type(jsdoc_lines: &[&str]) -> Option<String> {
    for line in jsdoc_lines {
        let trimmed = line.trim();
        // Strip JSDoc comment markers: /**, *, */
        let without_prefix = trimmed
            .strip_prefix("/**")
            .or_else(|| trimmed.strip_prefix("/*"))
            .or_else(|| trimmed.strip_prefix("*"))
            .unwrap_or(trimmed)
            .trim();

        let content = without_prefix
            .strip_suffix("*/")
            .unwrap_or(without_prefix)
            .trim();

        if content.starts_with("@returns") || content.starts_with("@return") {
            return extract_brace_content(content);
        }
    }
    None
}

/// Parse a method definition line and extract the method name.
fn parse_method_definition(line: &str) -> Option<String> {
    let trimmed = line.trim();

    // Skip empty lines, comments, and property declarations
    if trimmed.is_empty()
        || trimmed.starts_with("//")
        || trimmed.starts_with("/*")
        || trimmed.starts_with('*')
        || trimmed.starts_with('#')
    {
        return None;
    }

    // Pattern: methodName(params) { or async methodName( or get/set methodName(
    // Skip lines that are just closing braces or property assignments

    // Handle async methods: "async methodName("
    let work = if let Some(rest) = trimmed.strip_prefix("async ") {
        rest.trim()
    } else if let Some(rest) = trimmed.strip_prefix("static ") {
        rest.trim()
    } else if let Some(rest) = trimmed.strip_prefix("get ") {
        rest.trim()
    } else if let Some(rest) = trimmed.strip_prefix("set ") {
        rest.trim()
    } else {
        trimmed
    };

    // Handle static async: already handled "static " above, check for "async " again
    let work = if let Some(rest) = work.strip_prefix("async ") {
        rest.trim()
    } else {
        work
    };

    // Look for identifier followed by (
    let paren_pos = work.find('(')?;
    let name = work[..paren_pos].trim();

    // Validate it looks like an identifier
    if name.is_empty() {
        return None;
    }

    // Check if it's a valid identifier (starts with letter/underscore, contains only alphanum/_)
    let first_char = name.chars().next()?;
    if !first_char.is_alphabetic() && first_char != '_' {
        return None;
    }

    if !name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return None;
    }

    Some(name.to_string())
}

/// Extract _HINTS value from source.
fn extract_hints_value(source: &str, hint_line: usize) -> Option<String> {
    let lines: Vec<&str> = source.lines().collect();

    // Look for template literal or string value
    let mut in_template = false;
    let mut template_content = String::new();

    for line in lines.iter().skip(hint_line) {
        // Check for template literal start
        if line.contains("`") && !in_template {
            in_template = true;
            if let Some(start) = line.find('`') {
                let after_backtick = &line[start + 1..];
                if let Some(end) = after_backtick.find('`') {
                    // Single line template
                    return Some(after_backtick[..end].to_string());
                } else {
                    template_content.push_str(after_backtick);
                    template_content.push('\n');
                }
            }
            continue;
        }

        if in_template {
            if let Some(end) = line.find('`') {
                template_content.push_str(&line[..end]);
                return Some(template_content.trim().to_string());
            } else {
                template_content.push_str(line);
                template_content.push('\n');
            }
        }

        // Check for single/double quoted string
        if !in_template && (line.contains("\"") || line.contains("'")) {
            let quote = if line.contains("\"") { '"' } else { '\'' };
            if let Some(start) = line.find(quote) {
                let after_quote = &line[start + 1..];
                if let Some(end) = after_quote.find(quote) {
                    return Some(after_quote[..end].to_string());
                }
            }
        }
    }

    None
}

/// Extract SCHEMA object literal from plugin source.
///
/// Looks for: `export const SCHEMA = { ... } satisfies ConfigSchema;`
/// Parses the object literal into a ConfigSchema map.
fn extract_schema_value(source: &str, schema_line: usize) -> Option<ConfigSchema> {
    let lines: Vec<&str> = source.lines().collect();

    // Collect lines from the SCHEMA export until we find the closing pattern
    // Pattern: `} satisfies ConfigSchema` or `} satisfies ConfigSchema;`
    let mut object_content = String::new();
    let mut brace_depth = 0;
    let mut found_opening_brace = false;

    for line in lines.iter().skip(schema_line) {
        // Track brace depth
        for ch in line.chars() {
            if ch == '{' {
                if !found_opening_brace {
                    found_opening_brace = true;
                }
                brace_depth += 1;
            } else if ch == '}' {
                brace_depth -= 1;
            }
        }

        object_content.push_str(line);
        object_content.push('\n');

        // When we close all braces and the line contains "satisfies", we're done
        if found_opening_brace && brace_depth == 0 && line.contains("satisfies") {
            break;
        }
    }

    // Now parse the object content into a ConfigSchema
    parse_schema_object(&object_content)
}

/// Parse a TypeScript/JavaScript object literal into a ConfigSchema.
///
/// This handles the specific format of SCHEMA exports:
/// ```text
/// export const SCHEMA = {
///   fieldName: {
///     type: "string" as const,
///     description: "...",
///     default: ...,
///     ...
///   },
///   ...
/// } satisfies ConfigSchema;
/// ```
fn parse_schema_object(content: &str) -> Option<ConfigSchema> {
    let mut schema = ConfigSchema::new();

    // Find the outer object content between first { and last } before satisfies
    let start = content.find('{')?;
    let satisfies_pos = content.rfind("satisfies")?;
    let end = content[..satisfies_pos].rfind('}')?;

    if start >= end {
        return None;
    }

    let inner = &content[start + 1..end];

    // Split by field entries - each top-level field starts with `name: {`
    // We need to track brace depth to find field boundaries
    let mut current_field_name: Option<String> = None;
    let mut current_field_content = String::new();
    let mut brace_depth = 0;

    for line in inner.lines() {
        let trimmed = line.trim();

        // Check if this is a new field declaration at depth 0
        if brace_depth == 0 && trimmed.contains(':') && !trimmed.starts_with("//") {
            // If we have a previous field, parse it
            if let Some(name) = current_field_name.take() {
                if let Some(field) = parse_schema_field(&current_field_content) {
                    schema.insert(name, field);
                }
            }
            current_field_content.clear();

            // Extract field name (before the colon)
            if let Some(colon_pos) = trimmed.find(':') {
                let name = trimmed[..colon_pos].trim();
                // Skip if this looks like a nested property (type:, description:, etc.)
                if !name.is_empty()
                    && ![
                        "type",
                        "description",
                        "default",
                        "minimum",
                        "maximum",
                        "maxLength",
                        "required",
                        "promptKey",
                        "items",
                    ]
                    .contains(&name)
                {
                    current_field_name = Some(name.to_string());
                }
            }
        }

        // Track brace depth
        for ch in line.chars() {
            if ch == '{' {
                brace_depth += 1;
            } else if ch == '}' {
                brace_depth -= 1;
            }
        }

        current_field_content.push_str(line);
        current_field_content.push('\n');
    }

    // Don't forget the last field
    if let Some(name) = current_field_name {
        if let Some(field) = parse_schema_field(&current_field_content) {
            schema.insert(name, field);
        }
    }

    if schema.is_empty() {
        None
    } else {
        Some(schema)
    }
}

/// Parse a single schema field definition.
fn parse_schema_field(content: &str) -> Option<SchemaField> {
    // Extract key-value pairs from the field object
    let field_type = extract_string_value(content, "type")?;
    let description = extract_string_value(content, "description").unwrap_or_default();

    Some(SchemaField {
        field_type,
        description,
        default: extract_default_value(content),
        minimum: extract_number_value(content, "minimum"),
        maximum: extract_number_value(content, "maximum"),
        max_length: extract_number_value(content, "maxLength").map(|n| n as u32),
        required: extract_bool_value(content, "required"),
        prompt_key: extract_bool_value(content, "promptKey"),
        items: extract_items_value(content),
    })
}

/// Extract a string value from a key in an object literal.
fn extract_string_value(content: &str, key: &str) -> Option<String> {
    // Look for pattern: key: "value" or key: 'value'
    for line in content.lines() {
        let trimmed = line.trim();
        // Match: type: "string" as const, or description: "...",
        if trimmed.starts_with(key) && trimmed.contains(':') {
            let after_colon = trimmed.split(':').nth(1)?.trim();
            // Remove "as const" suffix and trailing comma
            let cleaned = after_colon
                .trim_start_matches('"')
                .trim_start_matches('\'')
                .split('"')
                .next()?
                .split('\'')
                .next()?
                .trim();
            if !cleaned.is_empty() {
                return Some(cleaned.to_string());
            }
        }
    }
    None
}

/// Extract a number value from a key in an object literal.
fn extract_number_value(content: &str, key: &str) -> Option<f64> {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with(key) && trimmed.contains(':') {
            let after_colon = trimmed.split(':').nth(1)?.trim();
            // Remove trailing comma
            let num_str = after_colon.trim_end_matches(',').trim();
            return num_str.parse().ok();
        }
    }
    None
}

/// Extract a boolean value from a key in an object literal.
fn extract_bool_value(content: &str, key: &str) -> Option<bool> {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with(key) && trimmed.contains(':') {
            let after_colon = trimmed.split(':').nth(1)?.trim();
            let val = after_colon.trim_end_matches(',').trim();
            return match val {
                "true" => Some(true),
                "false" => Some(false),
                _ => None,
            };
        }
    }
    None
}

/// Extract the default value (can be string, number, boolean, or array).
fn extract_default_value(content: &str) -> Option<serde_json::Value> {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("default") && trimmed.contains(':') {
            let after_colon = trimmed.split(':').nth(1)?.trim();
            let val = after_colon.trim_end_matches(',').trim();

            // Try to parse as JSON-like value
            if val.starts_with('[') {
                // Array - try to parse the whole thing
                // For simplicity, handle string arrays: ["a", "b", "c"]
                if let Some(array) = parse_string_array(val) {
                    return Some(serde_json::Value::Array(
                        array.into_iter().map(serde_json::Value::String).collect(),
                    ));
                }
            } else if val == "true" {
                return Some(serde_json::Value::Bool(true));
            } else if val == "false" {
                return Some(serde_json::Value::Bool(false));
            } else if let Ok(n) = val.parse::<f64>() {
                return Some(serde_json::json!(n));
            } else if val.starts_with('"') || val.starts_with('\'') {
                // String value
                let s = val
                    .trim_start_matches('"')
                    .trim_start_matches('\'')
                    .trim_end_matches('"')
                    .trim_end_matches('\'');
                return Some(serde_json::Value::String(s.to_string()));
            }
        }
    }
    None
}

/// Parse a string array literal like ["a", "b", "c"].
fn parse_string_array(val: &str) -> Option<Vec<String>> {
    if !val.starts_with('[') || !val.contains(']') {
        return None;
    }
    let inner = val.trim_start_matches('[').split(']').next()?.trim();
    let items: Vec<String> = inner
        .split(',')
        .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
        .filter(|s| !s.is_empty())
        .collect();
    Some(items)
}

/// Extract items definition for array types.
fn extract_items_value(content: &str) -> Option<SchemaItems> {
    // Look for: items: { type: "string" }
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("items") && trimmed.contains("type") {
            // Extract the type value
            if let Some(type_val) = extract_string_value(trimmed, "type") {
                return Some(SchemaItems {
                    item_type: type_val,
                });
            }
        }
    }
    None
}

/// Extracted JSDoc information.
struct JsDocInfo {
    description: Option<String>,
    params: Vec<ParamInfo>,
    returns: Option<ReturnsInfo>,
    type_annotation: Option<String>,
    requires: Vec<String>,
}

/// Parse JSDoc comment lines into structured data.
fn parse_jsdoc(lines: &[&str]) -> JsDocInfo {
    let mut description = None;
    let mut params = Vec::new();
    let mut returns = None;
    let mut type_annotation = None;
    let mut requires = Vec::new();

    for line in lines {
        // Strip leading * and whitespace
        let content = line
            .trim()
            .trim_start_matches("/**")
            .trim_start_matches("*/")
            .trim_start_matches('*')
            .trim();

        if content.is_empty() {
            continue;
        }

        // @param {Type} name - description
        if content.starts_with("@param") {
            if let Some(param) = parse_param_tag(content) {
                params.push(param);
            }
            continue;
        }

        // @returns {Type} description
        if content.starts_with("@return") {
            returns = parse_returns_tag(content);
            continue;
        }

        // @type {Type}
        if content.starts_with("@type") {
            type_annotation = extract_brace_content(content);
            continue;
        }

        // @requires specifier
        if content.starts_with("@requires")
            && let Some(spec) = content.strip_prefix("@requires").map(|s| s.trim())
            && !spec.is_empty()
        {
            requires.push(spec.split_whitespace().next().unwrap_or(spec).to_string());
            continue;
        }

        // @description text
        if content.starts_with("@description") {
            description = content
                .strip_prefix("@description")
                .map(|s| s.trim().to_string());
            continue;
        }

        // Skip other @ tags
        if content.starts_with('@') {
            continue;
        }

        // First non-tag line is implicit description
        if description.is_none() {
            description = Some(content.to_string());
        }
    }

    JsDocInfo {
        description,
        params,
        returns,
        type_annotation,
        requires,
    }
}

/// Parse @param tag.
fn parse_param_tag(content: &str) -> Option<ParamInfo> {
    // @param {Type} name - description
    // @param {Type} [name] - description (optional)
    // @param {Type} [name=default] - description (optional with default)
    let after_param = content.strip_prefix("@param")?.trim();

    // Extract type if present
    let (param_type, rest) = if after_param.starts_with('{') {
        let type_str = extract_brace_content(after_param);
        let rest_start = after_param.find('}').map(|i| i + 1).unwrap_or(0);
        (type_str, after_param[rest_start..].trim())
    } else {
        (None, after_param)
    };

    // Check for optional parameter syntax [name] or [name=default]
    let rest = rest.trim();
    let is_optional = rest.starts_with('[');
    let rest = rest.trim_start_matches('[');

    // Extract name (handle [name=default] syntax - stop at = or ] or space)
    let name_end = rest.find([' ', '-', ']', '=']).unwrap_or(rest.len());
    let name = rest[..name_end].to_string();
    if name.is_empty() {
        return None;
    }

    // Extract description (after name and optional -)
    // First skip past the closing bracket if this was optional
    let rest_after_name = &rest[name_end..];
    let rest_after_bracket = if is_optional {
        // Skip past the closing bracket
        if let Some(bracket_pos) = rest_after_name.find(']') {
            &rest_after_name[bracket_pos + 1..]
        } else {
            rest_after_name
        }
    } else {
        rest_after_name
    };

    let desc_start = rest_after_bracket.find('-').map(|i| i + 1);
    let description = desc_start
        .map(|start| rest_after_bracket[start..].trim())
        .filter(|desc| !desc.is_empty())
        .map(|s| s.to_string());

    Some(ParamInfo {
        name,
        param_type,
        description,
        required: !is_optional,
    })
}

/// Parse @returns tag.
fn parse_returns_tag(content: &str) -> Option<ReturnsInfo> {
    // @returns {Type} description
    let after_returns = content
        .strip_prefix("@returns")
        .or_else(|| content.strip_prefix("@return"))?
        .trim();

    let (return_type, rest) = if after_returns.starts_with('{') {
        let type_str = extract_brace_content(after_returns);
        let rest_start = after_returns.find('}').map(|i| i + 1).unwrap_or(0);
        (type_str, after_returns[rest_start..].trim())
    } else {
        (None, after_returns)
    };

    let description = if rest.is_empty() {
        None
    } else {
        Some(rest.to_string())
    };

    Some(ReturnsInfo {
        return_type,
        description,
    })
}

/// Extract content between balanced braces { }.
fn extract_brace_content(s: &str) -> Option<String> {
    let start = s.find('{')?;
    let mut depth = 1;
    let mut end = start + 1;

    for (i, c) in s[start + 1..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    end = start + 1 + i;
                    break;
                }
            }
            _ => {}
        }
    }

    if depth == 0 {
        Some(s[start + 1..end].to_string())
    } else {
        None
    }
}

/// Extract content between balanced delimiters.
fn extract_balanced(s: &str, open: char, close: char) -> Option<String> {
    let start = s.find(open)?;
    let mut depth = 1;
    let mut end = start + 1;

    for (i, c) in s[start + 1..].char_indices() {
        if c == open {
            depth += 1;
        } else if c == close {
            depth -= 1;
            if depth == 0 {
                end = start + 1 + i;
                break;
            }
        }
    }

    if depth == 0 {
        Some(s[start + 1..end].to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_simple_function() {
        let source = r#"
/**
 * Calculate CRC32 checksum.
 * @param {Uint8Array} data - Input data
 * @returns {number} CRC32 value
 */
export function crc32(data) {
    return 0;
}
"#;
        let config = MetadataConfig::default();
        let result = extract_module_metadata(source, &config);

        assert_eq!(result.exports.len(), 1);
        assert_eq!(result.exports[0].name, "crc32");
        assert_eq!(result.exports[0].kind, "function");
        assert!(
            result.exports[0]
                .description
                .as_ref()
                .unwrap()
                .contains("CRC32")
        );
        assert_eq!(result.exports[0].params.as_ref().unwrap().len(), 1);
    }

    #[test]
    fn test_extract_const() {
        let source = r#"
/** @type {number} */
export const PI = 3.14159;
"#;
        let config = MetadataConfig::default();
        let result = extract_module_metadata(source, &config);

        assert_eq!(result.exports.len(), 1);
        assert_eq!(result.exports[0].name, "PI");
        assert_eq!(result.exports[0].kind, "const");
    }

    #[test]
    fn test_extract_hints() {
        let source = r#"
export const _HINTS = `Use crc32() for checksums.`;
export function crc32() {}
"#;
        let config = MetadataConfig::default();
        let result = extract_module_metadata(source, &config);

        assert!(result.hints.is_some());
        assert!(result.hints.unwrap().contains("crc32"));
    }

    #[test]
    fn test_export_list() {
        let source = r#"
function foo() {}
function bar() {}
export { foo, bar };
"#;
        let config = MetadataConfig::default();
        let result = extract_module_metadata(source, &config);

        assert_eq!(result.exports.len(), 2);
        assert!(result.exports.iter().any(|e| e.name == "foo"));
        assert!(result.exports.iter().any(|e| e.name == "bar"));
    }

    #[test]
    fn test_extract_class_methods() {
        let source = r#"
class PresentationBuilder {
    constructor(opts) {
        this.opts = opts;
    }

    addSlide(bgXml, shapesXml, opts) {
        // Add a slide
    }

    build() {
        return this.slides;
    }

    getSlideCount() {
        return this.slides.length;
    }
}
"#;
        let config = MetadataConfig::default();
        let result = extract_module_metadata(source, &config);

        assert_eq!(result.classes.len(), 1);
        let class = &result.classes[0];
        assert_eq!(class.name, "PresentationBuilder");
        assert!(class.methods.contains(&"addSlide".to_string()));
        assert!(class.methods.contains(&"build".to_string()));
        assert!(class.methods.contains(&"getSlideCount".to_string()));
        // Constructor should NOT be in methods
        assert!(!class.methods.contains(&"constructor".to_string()));
    }

    #[test]
    fn test_extract_class_with_async_methods() {
        let source = r#"
export class FileBuilder {
    async writeFile(path, data) {
        // Write file
    }

    static create() {
        return new FileBuilder();
    }

    async readFile(path) {
        // Read file
    }
}
"#;
        let config = MetadataConfig::default();
        let result = extract_module_metadata(source, &config);

        assert_eq!(result.classes.len(), 1);
        let class = &result.classes[0];
        assert_eq!(class.name, "FileBuilder");
        assert!(class.methods.contains(&"writeFile".to_string()));
        assert!(class.methods.contains(&"create".to_string()));
        assert!(class.methods.contains(&"readFile".to_string()));
    }

    #[test]
    fn test_extract_multiple_classes() {
        let source = r#"
class Foo {
    doFoo() {}
}

class Bar {
    doBar() {}
    anotherBar() {}
}
"#;
        let config = MetadataConfig::default();
        let result = extract_module_metadata(source, &config);

        assert_eq!(result.classes.len(), 2);

        let foo = result.classes.iter().find(|c| c.name == "Foo").unwrap();
        assert!(foo.methods.contains(&"doFoo".to_string()));

        let bar = result.classes.iter().find(|c| c.name == "Bar").unwrap();
        assert!(bar.methods.contains(&"doBar".to_string()));
        assert!(bar.methods.contains(&"anotherBar".to_string()));
    }

    #[test]
    fn test_class_with_getters_setters() {
        let source = r#"
class Config {
    get value() {
        return this._value;
    }

    set value(v) {
        this._value = v;
    }

    getValue() {
        return this._value;
    }
}
"#;
        let config = MetadataConfig::default();
        let result = extract_module_metadata(source, &config);

        assert_eq!(result.classes.len(), 1);
        let class = &result.classes[0];
        assert!(class.methods.contains(&"value".to_string())); // getter
        assert!(class.methods.contains(&"getValue".to_string()));
    }

    #[test]
    fn test_param_required_vs_optional() {
        let source = r#"
/**
 * Create a shape with positioning.
 * @param {number} x - X position (required)
 * @param {number} y - Y position (required)
 * @param {number} [width] - Width (optional)
 * @param {number} [height=100] - Height with default (optional)
 * @param {string} [color] - Optional color
 * @returns {object} Shape object
 */
export function createShape(x, y, width, height, color) {
    return { x, y, width, height, color };
}
"#;
        let config = MetadataConfig::default();
        let result = extract_module_metadata(source, &config);

        assert_eq!(result.exports.len(), 1);
        let export = &result.exports[0];
        assert_eq!(export.name, "createShape");

        let params = export.params.as_ref().expect("should have params");
        assert_eq!(params.len(), 5);

        // x is required
        assert_eq!(params[0].name, "x");
        assert!(params[0].required, "x should be required");

        // y is required
        assert_eq!(params[1].name, "y");
        assert!(params[1].required, "y should be required");

        // width is optional
        assert_eq!(params[2].name, "width");
        assert!(!params[2].required, "width should be optional");

        // height is optional (with default)
        assert_eq!(params[3].name, "height");
        assert!(!params[3].required, "height should be optional");

        // color is optional
        assert_eq!(params[4].name, "color");
        assert!(!params[4].required, "color should be optional");
    }

    #[test]
    fn test_param_with_default_value() {
        // Test that [name=default] syntax correctly marks as optional
        let source = r#"
/**
 * Create rect.
 * @param {string} [fill='blue'] - Fill color with default
 */
export function rect(fill) {}
"#;
        let config = MetadataConfig::default();
        let result = extract_module_metadata(source, &config);

        let export = &result.exports[0];
        let params = export.params.as_ref().expect("should have params");
        assert_eq!(params[0].name, "fill");
        assert!(!params[0].required, "fill should be optional (has default)");
    }

    // ========================================================================
    // Phase 4.5.4 Tests: Method Return Types
    // ========================================================================

    #[test]
    fn test_extract_jsdoc_return_type_helper() {
        // Test the helper function directly
        let single_line = &["    /** @returns {number} */"];
        assert_eq!(
            extract_jsdoc_return_type(single_line),
            Some("number".to_string()),
            "Single-line JSDoc should extract return type"
        );

        let multi_line = &[
            "    /**",
            "     * Description.",
            "     * @returns {PresentationBuilder} Chained",
            "     */",
        ];
        assert_eq!(
            extract_jsdoc_return_type(multi_line),
            Some("PresentationBuilder".to_string()),
            "Multi-line JSDoc should extract return type"
        );

        let no_returns = &["    /** Just a comment */"];
        assert_eq!(
            extract_jsdoc_return_type(no_returns),
            None,
            "JSDoc without @returns should return None"
        );
    }

    #[test]
    fn test_extract_method_return_types() {
        let source = r#"
class PresentationBuilder {
    /**
     * Add a slide.
     * @returns {PresentationBuilder} This builder for chaining
     */
    addSlide(bgXml, shapesXml) {
        return this;
    }

    /**
     * Build the presentation.
     * @returns {Uint8Array} The presentation bytes
     */
    build() {
        return new Uint8Array();
    }

    /** @returns {number} */
    getSlideCount() {
        return this.slides.length;
    }
}
"#;
        let config = MetadataConfig::default();
        let result = extract_module_metadata(source, &config);

        assert_eq!(result.classes.len(), 1);
        let class = &result.classes[0];
        assert_eq!(class.name, "PresentationBuilder");

        // Check methods exist
        assert!(class.methods.contains(&"addSlide".to_string()));
        assert!(class.methods.contains(&"build".to_string()));
        assert!(class.methods.contains(&"getSlideCount".to_string()));

        // Check return types (Phase 4.5.4)
        assert_eq!(
            class.method_returns.get("addSlide"),
            Some(&"PresentationBuilder".to_string()),
            "addSlide should return PresentationBuilder"
        );
        assert_eq!(
            class.method_returns.get("build"),
            Some(&"Uint8Array".to_string()),
            "build should return Uint8Array"
        );
        assert_eq!(
            class.method_returns.get("getSlideCount"),
            Some(&"number".to_string()),
            "getSlideCount should return number"
        );
    }

    #[test]
    fn test_method_without_return_type() {
        let source = r#"
class Builder {
    // No JSDoc
    doSomething() {
        console.log("done");
    }

    /** Does another thing */
    doAnother() {
        return null;
    }
}
"#;
        let config = MetadataConfig::default();
        let result = extract_module_metadata(source, &config);

        let class = &result.classes[0];
        assert!(class.methods.contains(&"doSomething".to_string()));
        assert!(class.methods.contains(&"doAnother".to_string()));

        // Neither method has @returns, so method_returns should be empty
        assert!(
            class.method_returns.is_empty(),
            "No return types should be extracted"
        );
    }

    // ========================================================================
    // Phase 4.5.x Tests: Property Extraction
    // ========================================================================

    #[test]
    fn test_extract_class_properties_from_constructor() {
        let source = r#"
class PresentationBuilder {
    constructor(opts) {
        this.opts = opts;
        this.slides = [];
        this.metadata = {};
    }

    addSlide() {
        return this;
    }
}
"#;
        let config = MetadataConfig::default();
        let result = extract_module_metadata(source, &config);

        assert_eq!(result.classes.len(), 1);
        let class = &result.classes[0];

        // Should extract properties from this.* assignments
        assert!(
            class.properties.contains(&"opts".to_string()),
            "should extract 'opts' property"
        );
        assert!(
            class.properties.contains(&"slides".to_string()),
            "should extract 'slides' property"
        );
        assert!(
            class.properties.contains(&"metadata".to_string()),
            "should extract 'metadata' property"
        );

        // Methods should still work
        assert!(class.methods.contains(&"addSlide".to_string()));
    }

    #[test]
    fn test_extract_class_field_declarations() {
        let source = r#"
class ConfigStore {
    // Class field declarations (ES2022+)
    name = "default";
    count = 0;
    items = [];

    constructor() {
        this.initialized = true;
    }

    getName() {
        return this.name;
    }
}
"#;
        let config = MetadataConfig::default();
        let result = extract_module_metadata(source, &config);

        assert_eq!(result.classes.len(), 1);
        let class = &result.classes[0];

        // Should extract class field declarations
        assert!(
            class.properties.contains(&"name".to_string()),
            "should extract 'name' field"
        );
        assert!(
            class.properties.contains(&"count".to_string()),
            "should extract 'count' field"
        );
        assert!(
            class.properties.contains(&"items".to_string()),
            "should extract 'items' field"
        );
        // And constructor assignments
        assert!(
            class.properties.contains(&"initialized".to_string()),
            "should extract 'initialized' from constructor"
        );

        // Methods should still work
        assert!(class.methods.contains(&"getName".to_string()));
    }

    #[test]
    fn test_skip_private_properties() {
        let source = r#"
class Secret {
    _private = "hidden";

    constructor() {
        this._internal = "also hidden";
        this.public = "visible";
    }

    getValue() {
        return this.public;
    }
}
"#;
        let config = MetadataConfig::default();
        let result = extract_module_metadata(source, &config);

        let class = &result.classes[0];

        // Should skip _ prefixed properties
        assert!(
            !class.properties.contains(&"_private".to_string()),
            "should skip _private field"
        );
        assert!(
            !class.properties.contains(&"_internal".to_string()),
            "should skip _internal property"
        );

        // Public property should be extracted
        assert!(
            class.properties.contains(&"public".to_string()),
            "should extract 'public' property"
        );
    }

    #[test]
    fn test_extract_schema() {
        let source = r#"
import type { ConfigSchema, ConfigValues } from "../../plugin-schema-types.js";

export const SCHEMA = {
    baseDir: {
        type: "string" as const,
        description: "Base directory for all filesystem operations.",
        maxLength: 4096,
        promptKey: true,
    },
    maxFileSizeKb: {
        type: "number" as const,
        description: "Maximum file size in KB for reads.",
        default: 10240,
        minimum: 0,
        maximum: 10240,
    },
    enabled: {
        type: "boolean" as const,
        description: "Whether the feature is enabled.",
        default: false,
    },
} satisfies ConfigSchema;

export type FsReadConfig = ConfigValues<typeof SCHEMA>;
"#;
        let config = MetadataConfig {
            extract_schema: true,
            ..Default::default()
        };
        let result = extract_module_metadata(source, &config);

        assert!(result.schema.is_some(), "should extract SCHEMA");
        let schema = result.schema.unwrap();

        // Check baseDir field
        assert!(schema.contains_key("baseDir"), "should have baseDir field");
        let base_dir = schema.get("baseDir").unwrap();
        assert_eq!(base_dir.field_type, "string");
        assert!(base_dir.description.contains("Base directory"));
        assert_eq!(base_dir.max_length, Some(4096));
        assert_eq!(base_dir.prompt_key, Some(true));

        // Check maxFileSizeKb field
        assert!(
            schema.contains_key("maxFileSizeKb"),
            "should have maxFileSizeKb field"
        );
        let max_size = schema.get("maxFileSizeKb").unwrap();
        assert_eq!(max_size.field_type, "number");
        assert_eq!(max_size.minimum, Some(0.0));
        assert_eq!(max_size.maximum, Some(10240.0));
        // Check default value
        if let Some(serde_json::Value::Number(n)) = &max_size.default {
            assert_eq!(n.as_f64(), Some(10240.0));
        } else {
            panic!("Expected number default for maxFileSizeKb");
        }

        // Check enabled field
        assert!(schema.contains_key("enabled"), "should have enabled field");
        let enabled = schema.get("enabled").unwrap();
        assert_eq!(enabled.field_type, "boolean");
        if let Some(serde_json::Value::Bool(b)) = &enabled.default {
            assert!(!b);
        } else {
            panic!("Expected boolean default for enabled");
        }
    }

    #[test]
    fn test_extract_schema_disabled_by_default() {
        let source = r#"
export const SCHEMA = {
    field: { type: "string" as const, description: "test" },
} satisfies ConfigSchema;
"#;
        let config = MetadataConfig::default();
        let result = extract_module_metadata(source, &config);

        assert!(
            result.schema.is_none(),
            "should not extract SCHEMA when disabled"
        );
    }

    // ========================================================================
    // d.ts Metadata Extraction Tests
    // ========================================================================

    #[test]
    fn test_dts_const_with_value() {
        // Test that `export declare const FOO = "value"` correctly extracts just the name
        // This was a bug where:
        // 1. The string value was being included in the export name (fixed by checking for `=`)
        // 2. Strings containing "function" were wrongly parsed as function declarations (fixed by checking const first)
        let source = r#"export declare const _HINTS = "\nCRITICAL RULES:\n- ALL slide functions need pres as FIRST parameter";
export declare const SLIDE_WIDTH_INCHES = 13.333;
export declare const SLIDE_HEIGHT_INCHES = 7.5;
export declare function nextShapeId(): number;
"#;
        let config = MetadataConfig::default();
        let result = extract_dts_metadata(source, &config);

        let names: Vec<&str> = result.exports.iter().map(|e| e.name.as_str()).collect();

        // Should have 4 exports with correct names
        assert_eq!(
            result.exports.len(),
            4,
            "expected 4 exports, got: {:?}",
            names
        );

        let names: Vec<&str> = result.exports.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"_HINTS"), "should have _HINTS export");
        assert!(
            names.contains(&"SLIDE_WIDTH_INCHES"),
            "should have SLIDE_WIDTH_INCHES export"
        );
        assert!(
            names.contains(&"SLIDE_HEIGHT_INCHES"),
            "should have SLIDE_HEIGHT_INCHES export"
        );
        assert!(
            names.contains(&"nextShapeId"),
            "should have nextShapeId export"
        );

        // Ensure no export name contains the string value
        for export in &result.exports {
            assert!(
                !export.name.contains("CRITICAL"),
                "export name should not contain string value content: {}",
                export.name
            );
            assert!(
                !export.name.contains("="),
                "export name should not contain '=': {}",
                export.name
            );
        }
    }

    #[test]
    fn test_dts_const_with_type_annotation() {
        // Test the normal case: `export declare const FOO: Type;`
        let source = r#"
export declare const PI: number;
export declare const NAME: string;
"#;
        let config = MetadataConfig::default();
        let result = extract_dts_metadata(source, &config);

        assert_eq!(result.exports.len(), 2);
        assert_eq!(result.exports[0].name, "PI");
        assert_eq!(result.exports[1].name, "NAME");
    }

    #[test]
    fn test_dts_multiline_function() {
        // Test multi-line function declarations like shapes() with complex type params.
        // This is a real-world case from ha:pptx where the function signature spans multiple lines.
        let source = r#"
export declare function simpleFunc(x: number): number;
export declare function shapes(items: Array<string | {
    toString(): string;
} | null | undefined>): string;
export declare function anotherFunc(y: string): void;
"#;
        let config = MetadataConfig::default();
        let result = extract_dts_metadata(source, &config);

        let names: Vec<&str> = result.exports.iter().map(|e| e.name.as_str()).collect();
        assert!(
            names.contains(&"shapes"),
            "Multi-line function 'shapes' should be extracted. Got: {:?}",
            names
        );
        assert!(
            names.contains(&"simpleFunc"),
            "Single-line function 'simpleFunc' should be extracted. Got: {:?}",
            names
        );
        assert!(
            names.contains(&"anotherFunc"),
            "Function after multi-line 'anotherFunc' should be extracted. Got: {:?}",
            names
        );
        assert_eq!(result.exports.len(), 3, "Expected 3 exports, got {:?}", names);
    }

    #[test]
    fn test_dts_reexports() {
        // Test re-exports from other modules: export { a, b } from "module";
        // This is used in ha:pptx to re-export table functions from ha:pptx-tables.
        let source = r#"
export declare function localFunc(): void;
export { table, kvTable } from "ha:pptx-tables";
export declare const FOO: string;
"#;
        let config = MetadataConfig::default();
        let result = extract_dts_metadata(source, &config);

        let names: Vec<&str> = result.exports.iter().map(|e| e.name.as_str()).collect();
        assert!(
            names.contains(&"localFunc"),
            "Should have localFunc. Got: {:?}",
            names
        );
        assert!(
            names.contains(&"table"),
            "Should have re-exported table. Got: {:?}",
            names
        );
        assert!(
            names.contains(&"kvTable"),
            "Should have re-exported kvTable. Got: {:?}",
            names
        );
        assert!(
            names.contains(&"FOO"),
            "Should have FOO. Got: {:?}",
            names
        );
        assert_eq!(result.exports.len(), 4, "Expected 4 exports, got {:?}", names);
    }
}
