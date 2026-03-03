# Code Validation

All LLM-generated JavaScript is validated before execution using a Hyperlight-based validation sandbox.

## Overview

When the LLM generates code for a handler, it doesn't run immediately. First, it passes through a validation layer that:

1. Parses the code using QuickJS (same parser as runtime)
2. Validates syntax and structure
3. Checks imports against available modules
4. Reports errors before any execution

This catches common mistakes and ensures the code will actually run.

## The Validation Pipeline

```
┌──────────────┐    ┌─────────────────────┐    ┌──────────────────┐
│  LLM writes  │───▶│  Validation Guest   │───▶│  If valid:       │
│  JavaScript  │    │  (Rust in micro-VM) │    │  Execute in      │
└──────────────┘    └─────────────────────┘    │  Runtime Sandbox │
                             │                 └──────────────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │  If invalid:     │
                    │  Error message   │
                    │  to LLM          │
                    └──────────────────┘
```

## What Gets Validated

### Syntax Errors

The QuickJS parser catches JavaScript syntax errors:

```javascript
// Error: Unexpected token
function foo( {
  return 1;
}

// Error: Missing semicolon in strict mode
const x = 1
const y = 2
```

### Import Validation

Imports are checked against available modules:

```javascript
// Valid - module exists
import { encode } from "ha:base64";

// Error - unknown module
import { foo } from "ha:nonexistent";

// Error - wrong export name
import { doesNotExist } from "ha:base64";
```

### Module Availability

The validator knows which modules are available:

- **System modules**: Always available (base64, crc32, etc.)
- **User modules**: Checked against ~/.hyperagent/modules/
- **Plugin modules**: Only available if plugin enabled

### Handler Structure

Validates the expected handler structure:

```javascript
// Valid - default export function
export default function(event) {
  return event.value * 2;
}

// Error - missing default export
function process(event) {
  return event.value * 2;
}
```

## The Validation Guest

Validation runs in `hyperlight-analysis-guest`, a Rust program compiled to run in Hyperlight micro-VMs:

- **Isolated**: Validation runs in its own micro-VM
- **Safe**: No filesystem, network, or system access
- **Fast**: Compiled Rust for quick parsing
- **Accurate**: Uses the same QuickJS parser as runtime

### Why a Separate Guest?

1. **Security**: Validation is sandboxed, protecting against malicious patterns
2. **Fidelity**: Same parser ensures validation matches runtime behavior
3. **Performance**: Rust parsing is faster than JavaScript
4. **Isolation**: Validation cannot affect runtime state

## Validation Context

The validator receives context about the current state:

```typescript
interface ValidationContext {
  handlerName: string;           // Name of handler being registered
  availableModules: string[];    // System + user modules
  enabledPlugins: string[];      // Currently enabled plugins
  existingHandlers: string[];    // Already registered handlers
}
```

This allows context-aware validation:

- Check imports against actually available modules
- Validate plugin-specific imports
- Detect handler name conflicts

## Error Messages

Validation errors are returned to the LLM for correction:

```
Validation failed for handler "processor":

Line 3, Column 15: Import error
  import { encode } from "ha:base65";
              ^
  Module "ha:base65" not found. Did you mean "ha:base64"?

Line 7, Column 1: Syntax error
  export defalt function(event) {
         ^
  Unexpected identifier. Expected "default".
```

The LLM can then fix the code and try again.

## Performance

Validation adds minimal overhead:

| Operation | Typical Time |
|-----------|--------------|
| Parse small handler | < 1ms |
| Parse complex handler | 1-5ms |
| Full validation with checks | 5-10ms |

Compare to execution time of 100ms+, validation overhead is negligible.

## Disabling Validation

Validation is enabled by default when the native addon is available. It cannot be disabled at runtime — this is intentional for security.

If the validation guest is not available (native addon not built), handler registration **fails** with a validation error. There is no fallback — the Rust-based validator is required for code execution.

## Implementation Details

The validation guest is implemented in:

- `src/code-validator/guest/` - Rust source
- `src/agent/analysis-guest.ts` - TypeScript wrapper

Key functions:

```typescript
// Main validation entry point
validateJavaScript(source: string, context: ValidationContext): Promise<ValidationResponse>

// Module metadata extraction
extractModuleMetadata(source: string): Promise<ModuleMetadataResponse>

// Plugin security scanning
scanPlugin(source: string): Promise<ScanPluginResponse>
```

## See Also

- [SECURITY.md](SECURITY.md) - Full security architecture
- [HOW-IT-WORKS.md](HOW-IT-WORKS.md) - Overall system flow
- [MODULES.md](MODULES.md) - Available modules for imports
