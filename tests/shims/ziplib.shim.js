// Node.js shim for ha:ziplib — used by vitest for testing outside the sandbox.
// In the sandbox, ha:ziplib resolves to the native Rust module via NativeModuleLoader.
// This shim provides equivalent behaviour using Node.js zlib for test compatibility.
import { deflateRawSync, inflateRawSync } from "node:zlib";

export function deflate(data) {
  if (!data || data.length === 0) return new Uint8Array(0);
  return new Uint8Array(deflateRawSync(Buffer.from(data)));
}

export function inflate(data) {
  if (!data || data.length === 0) return new Uint8Array(0);
  return new Uint8Array(inflateRawSync(Buffer.from(data)));
}
