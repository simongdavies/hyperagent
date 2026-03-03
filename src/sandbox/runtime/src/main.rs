//! HyperAgent custom runtime — extends hyperlight-js with native modules.
//!
//! This binary provides the same JavaScript runtime as hyperlight-js-runtime
//! but with additional native Rust modules registered via the `native_modules!` macro.
//!
//! Works for both:
//! - Native CLI testing (`cargo run -- script.js handler_event`)
//! - Hyperlight guest execution (compiled with `cargo hyperlight build`)
//!
//! Native modules registered:
//! - "ha:ziplib" — DEFLATE compression/decompression via miniz_oxide

#![cfg_attr(hyperlight, no_std)]
#![cfg_attr(hyperlight, no_main)]

use native_deflate::js_deflate;
use native_html::js_html;
use native_image::js_image;
use native_markdown::js_markdown;
use native_globals::setup_globals;

// Register native modules into the global registry.
// Built-in modules (io, crypto, console, require) are inherited automatically.
hyperlight_js_runtime::native_modules! {
    "ha:ziplib" => js_deflate,
    "ha:image" => js_image,
    "ha:html" => js_html,
    "ha:markdown" => js_markdown,
}

// Register custom globals — TextEncoder, TextDecoder, atob, btoa,
// console.warn/.error/.info/.debug, queueMicrotask.
// Core encoding/decoding is in Rust (native-globals crate),
// JS constructors wrap the Rust functions.
hyperlight_js_runtime::custom_globals! {
    setup_globals,
}

// ── Native CLI entry point (for dev/testing) ───────────────────────────────

#[cfg(not(hyperlight))]
fn main() -> anyhow::Result<()> {
    use std::path::Path;
    use std::{env, fs};

    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        eprintln!("Usage: hyperagent-runtime <script.js> <event_json>");
        std::process::exit(1);
    }
    let file = std::path::PathBuf::from(&args[1]);
    let event = &args[2];

    let handler_script = fs::read_to_string(&file)?;
    let handler_pwd = file.parent().unwrap_or_else(|| Path::new("."));
    env::set_current_dir(handler_pwd)?;

    struct NoOpHost;
    impl hyperlight_js_runtime::host::Host for NoOpHost {
        fn resolve_module(&self, _base: String, name: String) -> anyhow::Result<String> {
            anyhow::bail!("Module '{name}' not found")
        }
        fn load_module(&self, name: String) -> anyhow::Result<String> {
            anyhow::bail!("Module '{name}' not found")
        }
    }

    let mut runtime = hyperlight_js_runtime::JsRuntime::new(NoOpHost)?;
    runtime.register_handler("handler", handler_script, ".")?;

    let result = runtime.run_handler("handler".into(), event.clone(), false)?;
    println!("Handler result: {result}");
    Ok(())
}

// For hyperlight builds: the lib's `guest` module provides hyperlight_main,
// guest_dispatch_function, and all plumbing. Nothing else needed here.
