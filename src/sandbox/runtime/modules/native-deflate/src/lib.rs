//! Native DEFLATE compression module.
//!
//! Provides deflate (compress) and inflate (decompress) via miniz_oxide.
//! Registered as "ha:ziplib" in the native module registry.
//! ~50-100x faster than the TypeScript implementation.

#![cfg_attr(hyperlight, no_std)]

#[cfg(hyperlight)]
extern crate alloc;

#[cfg(hyperlight)]
use alloc::vec::Vec;

use miniz_oxide::deflate::compress_to_vec;
use miniz_oxide::inflate::decompress_to_vec;
use rquickjs::{Exception, Result as QjsResult, Value};

/// Extract raw bytes from a JS Value (String or Uint8Array).
fn value_to_bytes(val: Value<'_>) -> QjsResult<Vec<u8>> {
    if let Some(txt) = val.as_string() {
        return Ok(txt.to_string()?.as_bytes().to_vec());
    }
    if let Some(obj) = val.as_object()
        && let Some(array) = obj.as_typed_array::<u8>()
        && let Some(bytes) = array.as_bytes()
    {
        return Ok(bytes.to_vec());
    }
    Err(Exception::throw_type(
        val.ctx(),
        "Expected a String or Uint8Array",
    ))
}

/// Deflate compression/decompression module.
///
/// Note: rquickjs generates a struct named `js_deflate` from `pub mod deflate`.
/// That struct is what gets registered in the native_modules! macro.
#[rquickjs::module(rename_vars = "camelCase")]
pub mod deflate {
    #[cfg(hyperlight)]
    use alloc::vec::Vec;

    use rquickjs::{Ctx, Exception, Result as QjsResult, Value};

    /// Usage hints for the LLM.
    #[qjs(rename = "_HINTS")]
    pub const _HINTS: &str = "\
deflate(data: Uint8Array): Uint8Array — compress using DEFLATE (RFC 1951).
  Returns raw DEFLATE output (no zlib/gzip wrapper).
  Used internally by ha:zip-format for ZIP/PPTX/DOCX compression.

inflate(data: Uint8Array): Uint8Array — decompress DEFLATE data.
  Expects raw DEFLATE input (no zlib/gzip wrapper).

Both accept Uint8Array or String input.
";

    /// Compress data using DEFLATE (RFC 1951).
    /// Produces raw DEFLATE output (no zlib or gzip wrapper).
    #[rquickjs::function]
    pub fn deflate(ctx: Ctx<'_>, data: Value<'_>) -> QjsResult<Vec<u8>> {
        let input = super::value_to_bytes(data)?;
        if input.is_empty() {
            return Ok(Vec::new());
        }
        // Level 6: good balance of speed and compression ratio
        let compressed = super::compress_to_vec(&input, 6);
        if compressed.is_empty() && !input.is_empty() {
            return Err(Exception::throw_message(&ctx, "DEFLATE compression failed"));
        }
        Ok(compressed)
    }

    /// Decompress DEFLATE-compressed data (RFC 1951).
    /// Expects raw DEFLATE input (no zlib or gzip wrapper).
    #[rquickjs::function]
    pub fn inflate(ctx: Ctx<'_>, data: Value<'_>) -> QjsResult<Vec<u8>> {
        let input = super::value_to_bytes(data)?;
        if input.is_empty() {
            return Ok(Vec::new());
        }
        match super::decompress_to_vec(&input) {
            Ok(decompressed) => Ok(decompressed),
            Err(_) => Err(Exception::throw_message(
                &ctx,
                "DEFLATE decompression failed: invalid or corrupt data",
            )),
        }
    }
}
