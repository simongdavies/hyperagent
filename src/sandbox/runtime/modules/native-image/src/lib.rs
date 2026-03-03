//! Native image utilities module.
//!
//! Reads image dimensions from PNG, JPEG, GIF, and BMP headers.
//! No external dependencies — pure byte parsing.
//! Registered as "ha:image" in the native module registry.

#![cfg_attr(hyperlight, no_std)]

#[cfg(hyperlight)]
extern crate alloc;

#[cfg(hyperlight)]
use alloc::vec::Vec;

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

// ── Header parsing ─────────────────────────────────────────────────────

/// PNG signature: 89 50 4E 47 0D 0A 1A 0A
const PNG_SIG: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/// Read width/height from PNG IHDR chunk (bytes 16-23).
fn png_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 24 || data[..8] != PNG_SIG {
        return None;
    }
    let w = u32::from_be_bytes([data[16], data[17], data[18], data[19]]);
    let h = u32::from_be_bytes([data[20], data[21], data[22], data[23]]);
    Some((w, h))
}

/// Read width/height from JPEG SOF0/SOF2 marker.
fn jpeg_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 4 || data[0] != 0xFF || data[1] != 0xD8 {
        return None;
    }
    let mut i = 2;
    while i < data.len().saturating_sub(9) {
        if data[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = data[i + 1];
        // SOF0 (0xC0), SOF1 (0xC1 skip), SOF2 (0xC2), SOF3 (0xC3)
        if (0xC0..=0xC3).contains(&marker) && marker != 0xC1 {
            let h = u16::from_be_bytes([data[i + 5], data[i + 6]]) as u32;
            let w = u16::from_be_bytes([data[i + 7], data[i + 8]]) as u32;
            return Some((w, h));
        }
        // Skip segment: length is big-endian, doesn't include the 2-byte marker
        if i + 3 >= data.len() {
            break;
        }
        let len = u16::from_be_bytes([data[i + 2], data[i + 3]]) as usize;
        i += 2 + len;
    }
    None
}

/// Read width/height from GIF header (bytes 6-9, little-endian).
fn gif_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 10 || data[0] != b'G' || data[1] != b'I' || data[2] != b'F' {
        return None;
    }
    let w = u16::from_le_bytes([data[6], data[7]]) as u32;
    let h = u16::from_le_bytes([data[8], data[9]]) as u32;
    Some((w, h))
}

/// Read width/height from BMP header (bytes 18-25, little-endian 32-bit).
fn bmp_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 26 || data[0] != b'B' || data[1] != b'M' {
        return None;
    }
    let w = u32::from_le_bytes([data[18], data[19], data[20], data[21]]);
    let h_raw = i32::from_le_bytes([data[22], data[23], data[24], data[25]]);
    // BMP height can be negative (top-down bitmap)
    let h = h_raw.unsigned_abs();
    Some((w, h))
}

// ── rquickjs module ────────────────────────────────────────────────────

/// Image utilities module.
///
/// Note: rquickjs generates struct `js_image` from `pub mod image`.
#[rquickjs::module(rename_vars = "camelCase")]
pub mod image {
    #[cfg(hyperlight)]
    use alloc::string::String;

    use rquickjs::{Ctx, Object, Result as QjsResult, Value};

    /// Usage hints for the LLM.
    #[qjs(rename = "_HINTS")]
    pub const _HINTS: &str = "\
getImageDimensions(data: Uint8Array, format: string): {width, height} | null
  Read dimensions from PNG/JPEG/GIF/BMP header bytes.
  Only reads header — does NOT decode the full image. Very fast.
  format: 'png', 'jpg'/'jpeg', 'gif', 'bmp'

detectImageDimensions(data: Uint8Array): {width, height, format} | null
  Auto-detects format from magic bytes, then reads dimensions.
  Use when you don't know the image format.

Use with pptx embedImage to calculate aspect-ratio-correct placement:
  const dims = getImageDimensions(imageData, 'png');
  const scale = Math.min(targetW / dims.width, targetH / dims.height);
";

    /// Read image dimensions from PNG, JPEG, GIF, or BMP header bytes.
    /// Returns {width, height} or null if the format is unrecognised.
    /// Only reads the header — does NOT decode the full image.
    #[rquickjs::function]
    pub fn get_image_dimensions<'js>(
        ctx: Ctx<'js>,
        data: Value<'js>,
        format: String,
    ) -> QjsResult<Value<'js>> {
        let bytes = super::value_to_bytes(data)?;

        let dims = match format.as_str() {
            "png" => super::png_dimensions(&bytes),
            "jpg" | "jpeg" => super::jpeg_dimensions(&bytes),
            "gif" => super::gif_dimensions(&bytes),
            "bmp" => super::bmp_dimensions(&bytes),
            _ => None,
        };

        match dims {
            Some((w, h)) => {
                let obj = Object::new(ctx.clone())?;
                obj.set("width", w)?;
                obj.set("height", h)?;
                Ok(obj.into_value())
            }
            None => Ok(Value::new_null(ctx)),
        }
    }

    /// Auto-detect image format from header bytes and return dimensions.
    /// Returns {width, height, format} or null if unrecognised.
    #[rquickjs::function]
    pub fn detect_image_dimensions<'js>(ctx: Ctx<'js>, data: Value<'js>) -> QjsResult<Value<'js>> {
        let bytes = super::value_to_bytes(data)?;

        // Try each format by signature
        let result = if bytes.len() >= 8 && bytes[..8] == super::PNG_SIG {
            super::png_dimensions(&bytes).map(|d| (d, "png"))
        } else if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xD8 {
            super::jpeg_dimensions(&bytes).map(|d| (d, "jpeg"))
        } else if bytes.len() >= 3 && &bytes[..3] == b"GIF" {
            super::gif_dimensions(&bytes).map(|d| (d, "gif"))
        } else if bytes.len() >= 2 && &bytes[..2] == b"BM" {
            super::bmp_dimensions(&bytes).map(|d| (d, "bmp"))
        } else {
            None
        };

        match result {
            Some(((w, h), fmt)) => {
                let obj = Object::new(ctx.clone())?;
                obj.set("width", w)?;
                obj.set("height", h)?;
                obj.set("format", fmt)?;
                Ok(obj.into_value())
            }
            None => Ok(Value::new_null(ctx)),
        }
    }
}
