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

//! NAPI bindings for the Hyperlight Analysis Guest.
//!
//! This crate provides Node.js bindings for secure code analysis operations
//! that run inside a Hyperlight micro-VM. All parsing and pattern matching
//! happens in the isolated guest, protecting the host from ReDoS and other
//! parsing vulnerabilities.
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────────┐
//! │ Node.js (Host)                                              │
//! │   └── NAPI bindings (this crate)                            │
//! │         └── Hyperlight Sandbox                              │
//! │               └── Analysis Runtime Guest (Rust, isolated)   │
//! └─────────────────────────────────────────────────────────────┘
//! ```
//!
//! # Security Properties
//!
//! - Guest binary integrity verified via SHA256 hash before every load
//! - All regex operations use linear-time DFA (no backtracking)
//! - Hypervisor isolation (KVM/MSHV/WHP) contains any guest crashes
//! - Host never parses untrusted code directly

#![deny(clippy::unwrap_used)]

mod runtime;
mod sandbox;

use napi::bindgen_prelude::*;
use napi_derive::napi;

// Include the embedded runtime binary and its hash
include!(concat!(env!("OUT_DIR"), "/host_resource.rs"));

/// Verify the embedded runtime binary integrity.
/// Returns the SHA256 hash if valid, or an error if corrupted.
fn verify_runtime_integrity() -> Result<&'static str> {
    use sha2::{Digest, Sha256};

    let mut hasher = Sha256::new();
    hasher.update(ANALYSIS_RUNTIME);
    let computed = hex::encode(hasher.finalize());

    if computed != ANALYSIS_RUNTIME_SHA256 {
        return Err(Error::new(
            Status::GenericFailure,
            format!(
                "Analysis runtime binary integrity check failed. Expected {}, got {}",
                ANALYSIS_RUNTIME_SHA256, computed
            ),
        ));
    }

    Ok(ANALYSIS_RUNTIME_SHA256)
}

/// Get the SHA256 hash of the embedded analysis runtime.
/// This can be used for audit logging.
#[napi]
pub fn get_runtime_hash() -> Result<String> {
    verify_runtime_integrity().map(|h| h.to_string())
}

/// Get the size of the embedded analysis runtime in bytes.
#[napi]
pub fn get_runtime_size() -> u32 {
    ANALYSIS_RUNTIME.len() as u32
}

/// Shutdown the analysis runtime.
///
/// This must be called before `process.exit()` to prevent SIGSEGV from
/// Rust TLS destructors racing with Node's exit handlers.
///
/// After calling this, all analysis functions will fail.
///
/// # Example
///
/// ```javascript
/// const analysis = require('hyperlight-analysis');
///
/// process.on('beforeExit', () => {
///   analysis.shutdown();
/// });
/// ```
#[napi]
pub fn shutdown() {
    runtime::shutdown_runtime();
}

/// Ping the analysis guest to verify it's working.
/// Returns a JSON response with the echoed input.
///
/// # Example
///
/// ```javascript
/// const { ping } = require('hyperlight-analysis');
/// const result = await ping('hello');
/// // result: '{"pong":"hello"}'
/// ```
#[napi]
pub async fn ping(input: String) -> Result<String> {
    verify_runtime_integrity()?;

    let result = sandbox::call_guest_function("ping", input).await?;
    Ok(result)
}

/// Extract module metadata from JavaScript source code.
///
/// Parses the source to extract:
/// - Export signatures (functions, classes, constants)
/// - JSDoc comments and type annotations
/// - `_HINTS` export for LLM guidance
///
/// All parsing happens in the isolated guest using linear-time regex.
///
/// # Arguments
///
/// * `source` - JavaScript ES module source code
/// * `config_json` - Optional JSON configuration (reserved for future use)
///
/// # Returns
///
/// JSON string with extracted metadata:
/// ```json
/// {
///   "exports": [
///     {"name": "crc32", "kind": "function", "signature": "crc32(data)", ...}
///   ],
///   "hints": "Module-specific LLM guidance",
///   "issues": []
/// }
/// ```
#[napi]
pub async fn extract_module_metadata(
    source: String,
    config_json: Option<String>,
) -> Result<String> {
    verify_runtime_integrity()?;

    let config = config_json.unwrap_or_else(|| "{}".to_string());

    // Pass source and config as two separate string parameters to guest
    sandbox::call_guest_function_2("extract_module_metadata", source, config).await
}

/// Extract module metadata from a TypeScript declaration (.d.ts) file.
///
/// Parses .d.ts files which have cleaner type information than JSDoc:
/// - `export declare function name(params): returnType;`
/// - `export interface Name { ... }`
/// - `export declare const name: Type;`
///
/// All parsing happens in the isolated guest using linear-time regex.
///
/// # Arguments
///
/// * `source` - TypeScript declaration file content
/// * `config_json` - Optional JSON configuration (reserved for future use)
///
/// # Returns
///
/// JSON string with extracted metadata (same format as extract_module_metadata)
#[napi]
pub async fn extract_dts_metadata(source: String, config_json: Option<String>) -> Result<String> {
    verify_runtime_integrity()?;

    let config = config_json.unwrap_or_else(|| "{}".to_string());

    // Pass source and config as two separate string parameters to guest
    sandbox::call_guest_function_2("extract_dts_metadata", source, config).await
}

/// Scan plugin source code for security issues.
///
/// Performs static analysis to detect:
/// - Dangerous patterns (eval, child_process, etc.)
/// - Suspicious code constructs
/// - Policy violations
///
/// # Arguments
///
/// * `source` - Plugin JavaScript source code
/// * `config_json` - Optional JSON configuration for scan rules
///
/// # Returns
///
/// JSON string with scan findings:
/// ```json
/// {
///   "findings": [
///     {"severity": "danger", "message": "Process execution detected", "line": 42}
///   ],
///   "source_size": 12345
/// }
/// ```
#[napi]
pub async fn scan_plugin(source: String, config_json: Option<String>) -> Result<String> {
    verify_runtime_integrity()?;

    let config = config_json.unwrap_or_else(|| "{}".to_string());
    let input = serde_json::json!({
        "source": source,
        "config": serde_json::from_str::<serde_json::Value>(&config).unwrap_or(serde_json::json!({}))
    });

    let input_str = serde_json::to_string(&input).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize input: {e}"),
        )
    })?;

    sandbox::call_guest_function("scan_plugin", input_str).await
}

/// Validate JavaScript source code for syntax errors and common issues.
///
/// This is the primary tool for LLM code validation before handler registration.
/// Checks:
/// - Syntax errors (via QuickJS parser - same as runtime)
/// - Import specifier validity
/// - Named import existence
/// - Handler structure requirements
/// - QuickJS compatibility warnings
///
/// # Arguments
///
/// * `source` - JavaScript source code to validate
/// * `context_json` - JSON context with validation parameters:
///   ```json
///   {
///     "handlerName": "my-handler",
///     "registeredHandlers": ["existing-handler"],
///     "availableModules": ["ha:pptx", "ha:zip-format"],
///     "expectHandler": true
///   }
///   ```
///
/// # Returns
///
/// JSON string with validation result:
/// ```json
/// {
///   "valid": true,
///   "errors": [],
///   "warnings": [{"type": "compatibility", "message": "...", "line": 15}]
/// }
/// ```
#[napi]
pub async fn validate_javascript(source: String, context_json: String) -> Result<String> {
    verify_runtime_integrity()?;

    // Pass source and context as two separate string parameters to guest
    sandbox::call_guest_function_2("validate_javascript", source, context_json).await
}

/// Analyze a library tarball for security issues.
///
/// Extracts and analyzes npm/GitHub tarballs to detect:
/// - Malicious install scripts
/// - Suspicious dependencies
/// - Code patterns indicating supply chain attacks
///
/// # Arguments
///
/// * `tgz_bytes` - Raw tarball bytes
/// * `config_json` - Optional JSON configuration
///
/// # Returns
///
/// JSON string with analysis report
#[napi]
pub async fn analyze_library(tgz_bytes: Buffer, config_json: Option<String>) -> Result<String> {
    verify_runtime_integrity()?;

    let config = config_json.unwrap_or_else(|| "{}".to_string());

    // For binary data, we need to base64 encode it for JSON transport
    let tgz_base64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &tgz_bytes);

    let input = serde_json::json!({
        "tgz_base64": tgz_base64,
        "config": serde_json::from_str::<serde_json::Value>(&config).unwrap_or(serde_json::json!({}))
    });

    let input_str = serde_json::to_string(&input).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize input: {e}"),
        )
    })?;

    sandbox::call_guest_function("analyze_library", input_str).await
}
