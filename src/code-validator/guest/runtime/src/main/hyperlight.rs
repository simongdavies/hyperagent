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

// Hyperlight guest entry point.
//
// This module is compiled when targeting the Hyperlight micro-VM.
// It exports guest functions that can be called from the host.

extern crate alloc;

mod stubs;

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use hyperlight_common::flatbuffer_wrappers::function_call::FunctionCall;
use hyperlight_common::flatbuffer_wrappers::function_types::ParameterValue;
use hyperlight_common::flatbuffer_wrappers::util::get_flatbuffer_result;
use hyperlight_guest::error::Result;
use hyperlight_guest_bin::guest_function;

/// Initialize the guest runtime.
/// Called automatically when the guest binary is loaded.
#[unsafe(no_mangle)]
pub extern "C" fn hyperlight_main() {
    // Initialize the QuickJS runtime for validation.
    // Following the pattern from hyperlight-js: static runtime initialized once.
    hyperlight_analysis_runtime::validator::init_runtime();
}

/// Ping function - echoes input back with "pong: " prefix.
/// Used to verify the guest is working correctly.
///
/// # Arguments
/// * `input` - String to echo back
///
/// # Returns
/// JSON string: `{"message": "pong: <input>"}`
#[guest_function("ping")]
fn ping(input: String) -> Result<String> {
    let result = hyperlight_analysis_runtime::ping(&input);
    Ok(serde_json::to_string(&result).unwrap_or_else(|_| r#"{"error":"serialization failed"}"#.into()))
}

/// Validate JavaScript source code.
///
/// # Arguments
/// * `source` - JavaScript source code to validate
/// * `context_json` - JSON-encoded ValidationContext
///
/// # Returns
/// JSON string: ValidationResult with valid, errors, warnings
#[guest_function("validate_javascript")]
fn validate_javascript(source: String, context_json: String) -> Result<String> {
    let context: hyperlight_analysis_runtime::ValidationContext = match serde_json::from_str(&context_json) {
        Ok(ctx) => ctx,
        Err(e) => {
            return Ok(format!(r#"{{"valid":false,"errors":[{{"type":"internal","message":"Invalid context: {}"}}],"warnings":[]}}"#, e));
        }
    };

    let result = hyperlight_analysis_runtime::validate_javascript(&source, &context);
    Ok(serde_json::to_string(&result).unwrap_or_else(|_| r#"{"valid":false,"errors":[{"type":"internal","message":"serialization failed"}],"warnings":[]}"#.into()))
}

// Placeholder for future functions - will be added in Phase 2/3
// #[guest_function("extract_module_metadata")]
// fn extract_module_metadata(source: String, config_json: String) -> Result<String>;
//
// #[guest_function("scan_plugin")]
// fn scan_plugin(source: String, config_json: String) -> Result<String>;

/// Guest dispatch function - required by hyperlight-guest-bin.
/// This is called by the host to invoke guest functions.
#[unsafe(no_mangle)]
pub fn guest_dispatch_function(function_call: FunctionCall) -> Result<Vec<u8>> {
    let function_name = function_call.function_name.as_str();
    let params = function_call.parameters.unwrap_or_default();

    // Helper to extract string parameter at index
    fn get_string_param(params: &[ParameterValue], index: usize) -> String {
        match params.get(index) {
            Some(ParameterValue::String(s)) => s.clone(),
            _ => String::new(),
        }
    }

    // Dispatch based on function name
    let result = match function_name {
        "ping" => {
            let input = get_string_param(&params, 0);
            let response = hyperlight_analysis_runtime::ping(&input);
            serde_json::to_string(&response)
                .unwrap_or_else(|_| r#"{"error":"serialization failed"}"#.into())
        }
        "validate_javascript" => {
            let source = get_string_param(&params, 0);
            let context_json = get_string_param(&params, 1);

            let context: hyperlight_analysis_runtime::ValidationContext =
                match serde_json::from_str(&context_json) {
                    Ok(ctx) => ctx,
                    Err(e) => {
                        let err_msg = format!(
                            r#"{{"valid":false,"errors":[{{"type":"internal","message":"Invalid context: {}"}}],"warnings":[]}}"#,
                            e
                        );
                        return Ok(get_flatbuffer_result(err_msg.as_str()));
                    }
                };

            let response = hyperlight_analysis_runtime::validate_javascript(&source, &context);
            serde_json::to_string(&response).unwrap_or_else(|_| {
                r#"{"valid":false,"errors":[{"type":"internal","message":"serialization failed"}],"warnings":[]}"#.into()
            })
        }
        "extract_module_metadata" => {
            let source = get_string_param(&params, 0);
            let config_json = get_string_param(&params, 1);

            let config: hyperlight_analysis_runtime::MetadataConfig =
                if config_json.is_empty() {
                    hyperlight_analysis_runtime::MetadataConfig::default()
                } else {
                    serde_json::from_str(&config_json).unwrap_or_default()
                };

            let response = hyperlight_analysis_runtime::extract_module_metadata(&source, &config);
            serde_json::to_string(&response).unwrap_or_else(|_| {
                r#"{"exports":[],"issues":[{"severity":"error","message":"serialization failed"}]}"#.into()
            })
        }
        "extract_dts_metadata" => {
            let source = get_string_param(&params, 0);
            let config_json = get_string_param(&params, 1);

            let config: hyperlight_analysis_runtime::MetadataConfig =
                if config_json.is_empty() {
                    hyperlight_analysis_runtime::MetadataConfig::default()
                } else {
                    serde_json::from_str(&config_json).unwrap_or_default()
                };

            let response = hyperlight_analysis_runtime::extract_dts_metadata(&source, &config);
            serde_json::to_string(&response).unwrap_or_else(|_| {
                r#"{"exports":[],"issues":[{"severity":"error","message":"serialization failed"}]}"#.into()
            })
        }
        "scan_plugin" => {
            let input_json = get_string_param(&params, 0);

            // Parse the combined input JSON (source + config)
            let input: serde_json::Value = match serde_json::from_str(&input_json) {
                Ok(v) => v,
                Err(e) => {
                    let err_msg = format!(
                        r#"{{"findings":[],"source_size":0,"error":"Invalid input: {}"}}"#,
                        e
                    );
                    return Ok(get_flatbuffer_result(err_msg.as_str()));
                }
            };

            let source = input
                .get("source")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let config: hyperlight_analysis_runtime::ScanConfig = input
                .get("config")
                .map(|v| serde_json::from_value(v.clone()).unwrap_or_default())
                .unwrap_or_default();

            let response = hyperlight_analysis_runtime::scan_plugin(source, &config);
            serde_json::to_string(&response).unwrap_or_else(|_| {
                r#"{"findings":[],"source_size":0,"error":"serialization failed"}"#.into()
            })
        }
        _ => {
            format!(r#"{{"error":"unknown function: {}"}}"#, function_name)
        }
    };

    Ok(get_flatbuffer_result(result.as_str()))
}
