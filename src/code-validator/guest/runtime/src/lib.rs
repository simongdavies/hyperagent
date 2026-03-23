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

//! Core analysis library.
//!
//! This module contains the analysis logic that is shared between
//! the Hyperlight guest and the native CLI.

#![cfg_attr(not(feature = "std"), no_std)]
// Prevent panics in release code - guest crashes bring down the host
#![deny(clippy::unwrap_used)]
#![deny(clippy::expect_used)]
#![deny(clippy::panic)]

extern crate alloc;

pub mod js_parser;
pub mod metadata;
pub mod plugin_scan;
pub mod validator;

use alloc::format;
use alloc::string::String;
use serde::{Deserialize, Serialize};

pub use metadata::{
    ExportInfo, MetadataConfig, MetadataIssue, ModuleMetadataResult, ParamInfo, ReturnsInfo,
    extract_dts_metadata, extract_module_metadata,
};
pub use plugin_scan::{ScanConfig, ScanFinding, ScanResult, scan_plugin};
pub use validator::{
    ValidationContext, ValidationError, ValidationResult, ValidationWarning, init_runtime,
};

/// Result of a ping operation (for testing connectivity).
#[derive(Debug, Serialize, Deserialize)]
pub struct PingResult {
    pub message: String,
}

/// Ping function - echoes input back with "pong: " prefix.
/// Used to verify the guest is working correctly.
pub fn ping(input: &str) -> PingResult {
    PingResult {
        message: format!("pong: {}", input),
    }
}

/// Validate JavaScript source code.
///
/// Wrapper around `validator::validate_javascript` for external callers.
pub fn validate_javascript(source: &str, context: &ValidationContext) -> ValidationResult {
    validator::validate_javascript(source, context)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ping() {
        let result = ping("hello");
        assert_eq!(result.message, "pong: hello");
    }

    #[test]
    fn test_ping_empty() {
        let result = ping("");
        assert_eq!(result.message, "pong: ");
    }
}
