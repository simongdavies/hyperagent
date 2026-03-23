//! Native globals — TextEncoder, TextDecoder, atob, btoa, console extras.
//!
//! Registers standard Web API globals that npm libraries expect.
//! Called via `custom_globals!` macro during runtime init.
//!
//! Core encoding logic is in Rust for performance and correctness.
//! JS constructor wrappers call into the Rust functions.

#![cfg_attr(hyperlight, no_std)]

#[cfg(hyperlight)]
extern crate alloc;

#[cfg(hyperlight)]
use alloc::string::String;
#[cfg(hyperlight)]
use alloc::vec::Vec;

use rquickjs::{Ctx, Function, Result as QjsResult, TypedArray};

// ── TextEncoder ─────────────────────────────────────────────────────────
//
// Implements the WHATWG Encoding API TextEncoder.
// encode() converts a JS string to UTF-8 bytes (Uint8Array).
// Rust strings are always valid UTF-8, so into_bytes() is zero-cost.

fn text_encoder_encode<'js>(ctx: Ctx<'js>, input: String) -> QjsResult<TypedArray<'js, u8>> {
    TypedArray::new(ctx, input.into_bytes())
}

// ── TextDecoder ─────────────────────────────────────────────────────────
//
// Implements the WHATWG Encoding API TextDecoder (UTF-8 only).
// decode() converts a Uint8Array to a JS string.

fn text_decoder_decode(input: Vec<u8>) -> QjsResult<String> {
    String::from_utf8(input)
        .map_err(|_| rquickjs::Error::new_from_js("bytes", "valid UTF-8 string"))
}

// ── atob / btoa ─────────────────────────────────────────────────────────
//
// Standard base64 encode/decode matching browser behavior.
// atob: base64 string → decoded Latin-1 string
// btoa: Latin-1 string (chars 0-255) → base64 string

const B64_CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_decode_char(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn rust_atob(encoded: String) -> QjsResult<String> {
    // Strip whitespace (browsers are lenient)
    let clean: Vec<u8> = encoded
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();

    let mut bytes = Vec::new();
    let mut i = 0;
    while i < clean.len() {
        let a = b64_decode_char(clean[i])
            .ok_or_else(|| rquickjs::Error::new_from_js("string", "valid base64"))?;
        let b = if i + 1 < clean.len() {
            b64_decode_char(clean[i + 1]).unwrap_or(0)
        } else {
            0
        };
        let c = if i + 2 < clean.len() && clean[i + 2] != b'=' {
            b64_decode_char(clean[i + 2]).unwrap_or(0)
        } else {
            0
        };
        let d = if i + 3 < clean.len() && clean[i + 3] != b'=' {
            b64_decode_char(clean[i + 3]).unwrap_or(0)
        } else {
            0
        };

        bytes.push((a << 2) | (b >> 4));
        if i + 2 < clean.len() && clean[i + 2] != b'=' {
            bytes.push(((b & 0x0F) << 4) | (c >> 2));
        }
        if i + 3 < clean.len() && clean[i + 3] != b'=' {
            bytes.push(((c & 0x03) << 6) | d);
        }

        i += 4;
    }

    // atob returns Latin-1 string (each byte becomes a char)
    Ok(bytes.iter().map(|&b| b as char).collect())
}

fn rust_btoa(input: String) -> QjsResult<String> {
    // Validate all chars are 0-255 (Latin-1)
    for c in input.chars() {
        if c as u32 > 255 {
            return Err(rquickjs::Error::new_from_js(
                "string",
                "Latin1 string (all characters must be 0-255)",
            ));
        }
    }

    let bytes: Vec<u8> = input.bytes().collect();
    let mut result = String::new();

    let mut i = 0;
    while i < bytes.len() {
        let a = bytes[i];
        let b = if i + 1 < bytes.len() { bytes[i + 1] } else { 0 };
        let c = if i + 2 < bytes.len() { bytes[i + 2] } else { 0 };

        result.push(B64_CHARS[(a >> 2) as usize] as char);
        result.push(B64_CHARS[(((a & 0x03) << 4) | (b >> 4)) as usize] as char);

        if i + 1 < bytes.len() {
            result.push(B64_CHARS[(((b & 0x0F) << 2) | (c >> 6)) as usize] as char);
        } else {
            result.push('=');
        }

        if i + 2 < bytes.len() {
            result.push(B64_CHARS[(c & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }

        i += 3;
    }

    Ok(result)
}

// ── Public setup function ────────────────────────────────────────────────
//
// Called by custom_globals! macro during runtime init.
// Registers TextEncoder, TextDecoder, atob, btoa, console extras,
// and queueMicrotask as globals.

pub fn setup_globals(ctx: &Ctx<'_>) -> QjsResult<()> {
    let globals = ctx.globals();

    // ── TextEncoder constructor ──────────────────────────────────
    // Rust function handles the UTF-8 encoding, JS wraps it in a constructor.
    // We capture the Rust fn in a closure so it survives cleanup.
    let encode_fn = Function::new(ctx.clone(), text_encoder_encode)?;
    globals.set("__ha_encode", encode_fn)?;
    ctx.eval::<(), _>(
        r#"
        (function() {
            const encode = globalThis.__ha_encode;
            globalThis.TextEncoder = function TextEncoder() {
                this.encoding = "utf-8";
                this.encode = function(input) {
                    return encode(String(input === undefined || input === null ? "" : input));
                };
                this.encodeInto = function(source, destination) {
                    const encoded = this.encode(source);
                    const len = Math.min(encoded.length, destination.length);
                    destination.set(encoded.subarray(0, len));
                    return { read: source.length, written: len };
                };
            };
            delete globalThis.__ha_encode;
        })();
    "#,
    )?;

    // ── TextDecoder constructor ──────────────────────────────────
    // Rust function handles the UTF-8 decoding, JS wraps it.
    let decode_fn = Function::new(ctx.clone(), text_decoder_decode)?;
    globals.set("__ha_decode", decode_fn)?;
    ctx.eval::<(), _>(r#"
        (function() {
            const decode = globalThis.__ha_decode;
            globalThis.TextDecoder = function TextDecoder(label, options) {
                const enc = (label || "utf-8").toLowerCase();
                if (enc !== "utf-8" && enc !== "utf8") {
                    throw new RangeError("Only UTF-8 encoding is supported");
                }
                this.encoding = "utf-8";
                this.fatal = !!(options && options.fatal);
                this.decode = function(input) {
                    if (input === undefined || input === null) return "";
                    const bytes = (input instanceof Uint8Array) ? input : new Uint8Array(input.buffer || input);
                    return decode(Array.from(bytes));
                };
            };
            delete globalThis.__ha_decode;
        })();
    "#)?;

    // ── atob / btoa ──────────────────────────────────────────────
    let atob_fn = Function::new(ctx.clone(), rust_atob)?;
    let btoa_fn = Function::new(ctx.clone(), rust_btoa)?;
    globals.set("atob", atob_fn)?;
    globals.set("btoa", btoa_fn)?;

    // ── console.warn/error/info/debug ────────────────────────────
    // Alias to console.log since the sandbox has no stderr distinction.
    // Works because hyperlight-js now creates console as an extensible
    // plain Object (not a frozen module namespace) and freezes it AFTER
    // custom_globals! runs.
    ctx.eval::<(), _>(r#"
        if (typeof globalThis.console === 'object' && typeof globalThis.console.log === 'function') {
            globalThis.console.warn = globalThis.console.log;
            globalThis.console.error = globalThis.console.log;
            globalThis.console.info = globalThis.console.log;
            globalThis.console.debug = globalThis.console.log;
        }
    "#)?;

    // ── queueMicrotask ──────────────────────────────────────────
    ctx.eval::<(), _>(
        r#"
        if (typeof globalThis.queueMicrotask === 'undefined') {
            globalThis.queueMicrotask = function(fn) {
                Promise.resolve().then(fn);
            };
        }
    "#,
    )?;

    Ok(())
}
