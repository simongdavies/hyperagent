# Hyperlight Analysis Guest

Secure code analysis via Hyperlight micro-VM isolation.

## Overview

This crate provides secure code analysis operations that run inside a Hyperlight micro-VM. All parsing and pattern matching happens in the isolated guest, protecting the host process from ReDoS and other parsing vulnerabilities.

### Security Properties

- **Hypervisor isolation**: All analysis runs in a hardware-isolated micro-VM (KVM/MSHV/WHP)
- **Linear-time regex**: Uses regex-automata DFA engine (no backtracking, ReDoS impossible)
- **Binary integrity**: SHA256 verified before every guest load
- **Stateless design**: Each analysis call is independent

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Node.js (Host)                                              │
│   └── NAPI bindings (hyperlight-analysis)                   │
│         └── Hyperlight Sandbox                              │
│               └── Analysis Runtime Guest (Rust, isolated)   │
└─────────────────────────────────────────────────────────────┘
```

## Building

### Prerequisites

- Rust nightly toolchain
- Node.js >= 18
- Just command runner (`cargo install just`)
- Hypervisor support:
  - **Linux**: KVM (`/dev/kvm`) or MSHV (`/dev/mshv`)
  - **Windows**: Windows Hypervisor Platform (WHP)

### Build Commands

```bash
# Install dependencies
just install

# Build everything (runtime + host + NAPI)
just all

# Development build (debug mode)
just dev

# Build specific components
just build-runtime      # Guest binary only
just build              # Host crate only
just build-napi         # NAPI addon only
```

## Usage

### JavaScript/TypeScript

```javascript
const analysis = require('hyperlight-analysis');

// Verify the runtime is working
const pingResult = await analysis.ping('hello');
console.log(pingResult); // {"pong":"hello"}

// Get runtime integrity hash
console.log(analysis.getRuntimeHash());

// Validate JavaScript code before registration
const validationResult = await analysis.validateJavascript(
  'export function handler(event) { return event.data; }',
  JSON.stringify({
    handlerName: 'my-handler',
    registeredHandlers: [],
    availableModules: { 'ha:pptx': ['createPresentation'] },
    expectHandler: true
  })
);
console.log(JSON.parse(validationResult));

// Extract module metadata
const metadata = await analysis.extractModuleMetadata(`
  /**
   * Calculate CRC32 checksum.
   * @param {Uint8Array} data - Input data
   * @returns {number} Checksum
   */
  export function crc32(data) { /* ... */ }
`);
console.log(JSON.parse(metadata));

// Scan plugin for security issues
const scanResult = await analysis.scanPlugin(`
  const { exec } = require('child_process');
  exec('rm -rf /');
`);
console.log(JSON.parse(scanResult));
```

### TypeScript Types

Full TypeScript definitions are provided in `index.d.ts`:

```typescript
import {
  ping,
  validateJavascript,
  extractModuleMetadata,
  scanPlugin,
  ValidationResponse,
  ModuleMetadataResponse,
  ScanPluginResponse,
} from 'hyperlight-analysis';
```

## API Reference

### `ping(input: string): Promise<string>`

Verify the analysis guest is working. Returns `{"pong":"<input>"}`.

### `getRuntimeHash(): string`

Get the SHA256 hash of the embedded analysis runtime binary.

### `getRuntimeSize(): number`

Get the size of the embedded analysis runtime in bytes.

### `validateJavascript(source: string, contextJson: string): Promise<string>`

Validate JavaScript source code for syntax errors and common issues. This is the primary tool for LLM code validation before handler registration.

**Context Parameters:**
- `handlerName`: Name of the handler being registered
- `registeredHandlers`: Array of existing handler names (for conflict detection)
- `availableModules`: Map of module specifier → export names
- `expectHandler`: Whether to validate handler structure

**Returns:** `ValidationResponse` as JSON

### `extractModuleMetadata(source: string, configJson?: string): Promise<string>`

Extract export signatures, JSDoc comments, and `_HINTS` from module source.

**Returns:** `ModuleMetadataResponse` as JSON

### `scanPlugin(source: string, configJson?: string): Promise<string>`

Scan plugin source for dangerous patterns (eval, child_process, etc.).

**Returns:** `ScanPluginResponse` as JSON

### `analyzeLibrary(tgzBytes: Buffer, configJson?: string): Promise<string>`

Analyze a library tarball for security issues.

## Testing

```bash
# Run all tests
just test

# Rust tests only
just test-rust

# Node.js tests only
just test-node
```

## CI

```bash
# Full CI check (format, lint, test)
just ci
```

## Crate Structure

```
deps/hyperlight-analysis-guest/
├── Cargo.toml           # Workspace root
├── package.json         # npm package
├── index.js             # JS entry point
├── index.d.ts           # TypeScript types
├── Justfile             # Build recipes
├── host/                # Host crate (NAPI cdylib)
│   ├── Cargo.toml
│   ├── build.rs         # Builds runtime, embeds binary
│   └── src/
│       ├── lib.rs       # NAPI exports
│       └── sandbox.rs   # Hyperlight sandbox management
└── runtime/             # Guest binary crate
    ├── Cargo.toml
    ├── build.rs         # Bindgen setup
    ├── include/         # Libc stubs
    └── src/
        ├── main.rs      # Entry point dispatcher
        ├── lib.rs       # Core analysis logic
        ├── libc.rs      # Libc bindings
        └── main/
            ├── hyperlight.rs  # Guest function exports
            └── native.rs      # CLI for testing
```

## License

Apache-2.0. Copyright 2026  The Hyperlight Authors.
