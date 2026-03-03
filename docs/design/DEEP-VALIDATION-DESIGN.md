# Deep Method Validation Design

## Open Questions (Answered)

**1. How deep to track types?**
- **Answer: Option A** - Just direct function returns
- `const pres = createPresentation()` → know `pres` is `PresentationBuilder`
- Covers 90% of made-up method errors with minimal complexity
- The LLM writes simple sequential code, not complex nested types

**2. Handle destructuring?**
- **Answer: No** - Pattern is rare in handler code
- LLM writes `pres.addSlide()` not `const { addSlide } = pres`

**3. Validate parameters?**
- **Answer: Defer** - Separate problem from method existence
- Current errors are "method doesn't exist", not "wrong parameters"
- Can add later as Phase 2

**4. Cache invalidation?**
- **Answer: Simple** - Modules are immutable after creation
- Extract metadata once when module is registered
- Store alongside module source

---

## Problem Statement

The `register_handler` tool now calls validation transparently before registration. The validator checks:
- ✅ JavaScript syntax (QuickJS parse)
- ✅ Import specifiers exist (e.g., `"ha:pptx"` is a valid module)
- ✅ Handler function structure
- ✅ Handler name conflicts
- ✅ QuickJS compatibility warnings (Buffer, require, etc.)
- ✅ Method existence on known types (Phase 4.5)
- ✅ Required parameter validation (Phase 4.5.2)
- ✅ Void return type warnings (Phase 4.5.3)
- ✅ Property access validation (Phase 4.5.4)
- ✅ Destructuring validation (Phase 4.5.4)
- ✅ Conditional type narrowing (Phase 4.5.4)

**Note:** Validation is called **transparently** by `register_handler` — no separate tool or LLM call is required. This was a design decision to reduce friction and ensure all code is validated.

Before Phase 4.5 implementation, 5/10 tuning iterations hit runtime "not a function" errors for made-up methods like `pres.addBody()` (120 occurrences) and `pres.addShapes()` (31 occurrences).

---

## Architecture Constraint: no_std Guest

All code processing must happen in the Hyperlight guest, which runs in a `no_std` environment. This means:
- No std library (use `alloc` crate instead)
- No external crates that require std
- Must work with `x86_64-hyperlight-none` target

From LIBRARY-IMPORT-DESIGN.md:
> "The host NEVER parses, decompresses, or evaluates untrusted code"

### Standard Tools Considered

| Crate | no_std | Purpose | Verdict |
|-------|--------|---------|---------|
| `oxc_jsdoc` | No | Full JSDoc parser | Requires std, too heavy |
| `jsdoc` | No | JSDoc parser using nom + swc | swc_atoms requires std |
| `doctor` | Maybe | Low-level doc comment parser | Uses nom 6.x, might work |
| `nom` | **Yes** | Parser combinators | `default-features = false` |

**Decision:** Extend existing `metadata.rs` rather than adding external dependencies.
- Already no_std compatible (uses `extern crate alloc`)
- Already handles JSDoc basics (`@param`, `@returns`, `@type`)
- Just needs class method extraction added
- Uses line-by-line parsing (no ReDoS-vulnerable regex)

---

## Current Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ LLM calls register_handler(name, code)                          │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│ Host: agent.ts                                                  │
│                                                                  │
│  1. Build ValidationContext:                                     │
│     - handlerName, registeredHandlers, availableModules          │
│     - moduleSources: Record<string, string> (raw JS source)      │
│                                                                  │
│  2. Iterative resolution loop (max 20 iterations):               │
│     - Call validateJavaScript(code, context)                     │
│     - If missing_sources returned, resolve them:                 │
│       - ha:* → loadModule() from disk                            │
│       - host:* → pluginManager.loadSource()                      │
│     - Add resolved sources to context.moduleSources              │
│     - Repeat until deepValidationDone = true                     │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│ Guest: validator.rs (no_std, Hyperlight sandbox)                │
│                                                                  │
│  - extract_imports() → string parsing for import specifiers      │
│  - check_handler_export() → regex for function handler           │
│  - check_syntax_with_quickjs() → QuickJS Module::declare()       │
│  - check_compatibility_warnings() → Node.js-ism detection        │
│                                                                  │
│  Returns: { valid, errors, warnings, imports, missing_sources }  │
└─────────────────────────────────────────────────────────────────┘
```

### What Already Exists in Guest

The guest already has metadata extraction in `metadata.rs`:
- `extract_module_metadata(source, config)` - extracts exports, JSDoc, _HINTS
- Uses line-by-line parsing (no ReDoS-vulnerable regex)
- Returns `ExportInfo` with name, kind, signature, params, returns
- Already parses `@returns {Type}` tags

**Missing:** Class method extraction for return type tracking.

---

## Revised Architecture

All untrusted code processing happens in the Hyperlight guest:

```
┌─────────────────────────────────────────────────────────────────┐
│ MODULE REGISTRATION (one-time per module)                       │
│                                                                  │
│  Host receives module source                                     │
│         │                                                        │
│         ▼                                                        │
│  Guest: extractModuleMetadata(source)  ← ALREADY EXISTS          │
│         │                                                        │
│         ▼                                                        │
│  Returns: { exports, hints, classes }  ← ADD classes field       │
│         │                                                        │
│         ▼                                                        │
│  Host caches metadata with module (module-store.ts)              │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ HANDLER VALIDATION (every register_handler call)                │
│                                                                  │
│  Host builds ValidationContext:                                  │
│    - moduleSources: { "ha:pptx": "..." }     ← existing          │
│    - moduleMetadata: { "ha:pptx": {...} }    ← NEW (from cache)  │
│         │                                                        │
│         ▼                                                        │
│  Guest: validateJavaScript(code, context)                        │
│    1. Parse imports                                              │
│    2. Track variable types from assignments                      │
│    3. Validate method calls against class metadata               │
│         │                                                        │
│         ▼                                                        │
│  Returns: { valid, errors } with method-not-found errors         │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
                     ┌─────────────────┐
                     │  Module Source  │
                     └────────┬────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
    ┌─────────────────┐             ┌─────────────────┐
    │  Guest:         │             │  Guest:         │
    │  extractModule  │             │  validateJS     │
    │  Metadata()     │             │  (handler code) │
    └────────┬────────┘             └────────┬────────┘
             │                               │
             ▼                               │
    ┌─────────────────┐                      │
    │  ModuleMetadata │                      │
    │  - exports[]    │──────────────────────┘
    │  - classes{}    │     (passed in context)
    │  - hints        │
    └─────────────────┘
```

---

## Data Model Changes

### 1. Add ClassInfo to metadata.rs

```rust
/// Information about a class and its methods.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassInfo {
    /// Class name.
    pub name: String,
    /// Instance method names.
    pub methods: Vec<String>,
    /// Instance property names (optional).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub properties: Option<Vec<String>>,
}

/// Result of module metadata extraction (UPDATED).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleMetadataResult {
    pub exports: Vec<ExportInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hints: Option<String>,
    pub issues: Vec<MetadataIssue>,
    /// Class definitions with methods (NEW)
    #[serde(default)]
    pub classes: Vec<ClassInfo>,
}
```

### 2. ExportInfo already has return types

Already exists in metadata.rs:
```rust
pub struct ReturnsInfo {
    pub return_type: Option<String>,  // e.g., "PresentationBuilder"
    pub description: Option<String>,
}
```

Just need to ensure JSDoc `@returns {Type}` is consistently parsed.

### 3. Update ValidationContext in validator.rs

```rust
#[derive(Debug, Deserialize)]
pub struct ValidationContext {
    pub handler_name: String,
    pub registered_handlers: Vec<String>,
    pub available_modules: Vec<String>,
    pub expect_handler: bool,
    pub module_sources: BTreeMap<String, String>,
    // NEW: Pre-extracted metadata for each module
    pub module_metadata: BTreeMap<String, ModuleMetadataForValidation>,
}

#[derive(Debug, Deserialize)]
pub struct ModuleMetadataForValidation {
    /// Export names and their return types
    pub exports: Vec<ExportSummary>,
    /// Class definitions with methods
    pub classes: BTreeMap<String, ClassSummary>,
}

#[derive(Debug, Deserialize)]
pub struct ExportSummary {
    pub name: String,
    pub kind: String,  // "function", "const", "class"
    pub returns_type: Option<String>,  // For functions: what type they return
}

#[derive(Debug, Deserialize)]
pub struct ClassSummary {
    pub methods: Vec<String>,
}
```

---

## Implementation Plan

### Phase 1: Class Method Extraction (metadata.rs)

Add class method parsing to existing `extract_module_metadata()`:

```rust
/// Parse class body to extract method names.
fn extract_class_methods(source: &str, class_start: usize) -> Vec<String> {
    let mut methods = Vec::new();
    let mut depth = 0;
    let mut in_class = false;

    for line in source[class_start..].lines() {
        let trimmed = line.trim();

        // Track brace depth
        depth += trimmed.matches('{').count();
        depth -= trimmed.matches('}').count();

        if depth == 0 && in_class {
            break; // End of class
        }
        if depth > 0 {
            in_class = true;
        }

        // Look for method definitions (depth == 1 means direct class member)
        if depth == 1 {
            // Pattern: methodName(params) { or async methodName(
            if let Some(method_name) = parse_method_definition(trimmed) {
                if method_name != "constructor" {
                    methods.push(method_name);
                }
            }
        }
    }
    methods
}
```

### Phase 2: Symbol Tracking (validator.rs)

Track variable types through simple assignment:

```rust
struct SymbolTable {
    // variable_name → type_name
    bindings: BTreeMap<String, String>,
}

impl SymbolTable {
    fn track_assignment(&mut self, line: &str, context: &ValidationContext) {
        // Pattern: const/let/var name = importedFunction(...)
        // Example: const pres = createPresentation()

        // 1. Extract variable name and function call
        if let Some((var_name, func_name)) = parse_simple_assignment(line) {
            // 2. Find function in module exports
            for (_specifier, metadata) in &context.module_metadata {
                for export in &metadata.exports {
                    if export.name == func_name {
                        if let Some(ref return_type) = export.returns_type {
                            self.bindings.insert(var_name, return_type.clone());
                        }
                    }
                }
            }
        }
    }
}
```

### Phase 3: Method Call Validation (validator.rs)

Validate method calls against tracked types:

```rust
fn validate_method_calls(
    source: &str,
    symbols: &SymbolTable,
    context: &ValidationContext,
) -> Vec<ValidationError> {
    let mut errors = Vec::new();

    // Find all method calls: identifier.method(
    for (object, method, line_num) in extract_method_calls(source) {
        // Look up object's type
        if let Some(type_name) = symbols.bindings.get(&object) {
            // Find class in module metadata
            let method_exists = context.module_metadata.values().any(|meta| {
                meta.classes
                    .get(type_name)
                    .map(|c| c.methods.contains(&method))
                    .unwrap_or(false)
            });

            if !method_exists {
                // Collect available methods for error message
                let available: Vec<_> = context
                    .module_metadata
                    .values()
                    .filter_map(|m| m.classes.get(type_name))
                    .flat_map(|c| &c.methods)
                    .cloned()
                    .collect();

                errors.push(ValidationError {
                    error_type: "method".to_string(),
                    message: format!(
                        "Method '{}' does not exist on {}. Available methods: {}",
                        method,
                        type_name,
                        available.join(", ")
                    ),
                    line: Some(line_num),
                    column: None,
                });
            }
        }
    }

    errors
}
```

### Phase 4: Host Integration (agent.ts + module-store.ts)

**4.1 When registering a module, extract and cache metadata:**

```typescript
// module-store.ts
async function registerModule(name: string, source: string) {
  // Call guest to extract metadata (safe, in sandbox)
  const metadata = await analysisGuest.extractModuleMetadata(source);

  // Store alongside source
  await saveModule(name, {
    source,
    exports: metadata.exports,
    classes: metadata.classes,  // NEW
    hints: metadata.hints
  });
}
```

**4.2 When validating handler, pass cached metadata:**

```typescript
// agent.ts - resolveModuleSourcesFromImports()
async function resolveModuleSourcesFromImports(imports: string[]) {
  const sources: Record<string, string> = {};
  const metadata: Record<string, ModuleMetadataForValidation> = {};

  for (const specifier of imports) {
    if (specifier.startsWith("ha:")) {
      const mod = await loadModule(specifier.slice(3));
      sources[specifier] = mod.source;

      // Use cached metadata (extracted when module was registered)
      metadata[specifier] = {
        exports: mod.exports.map(e => ({
          name: e.name,
          kind: e.kind,
          returnsType: e.returns?.type
        })),
        classes: mod.classes  // From cached extraction
      };
    }
  }

  return { sources, metadata };
}
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `analysis-guest/runtime/src/metadata.rs` | Add `ClassInfo`, extract class methods |
| `analysis-guest/runtime/src/validator.rs` | Add symbol tracking, method validation |
| `analysis-guest/index.d.ts` | Update TypeScript types for metadata |
| `agent/module-store.ts` | Cache metadata from guest extraction |
| `agent.ts` | Pass metadata in ValidationContext |

**Note:** No changes to `jsdoc-parser.ts` - we're replacing host-side parsing with guest extraction entirely.

---

## Error Messages

**Good (with this design):**
```
Method 'addBody' does not exist on PresentationBuilder.
Available methods: addSlide, build, getSlideCount
```

**Bad (current runtime error):**
```
TypeError: pres.addBody is not a function
```

---

## Success Criteria

1. `pres.addBody([...])` returns error **before** registration
2. `pres.addSlide(...)` passes validation
3. `solidFill('000000')` returns "not exported" error (already works)
4. Error messages list available methods
5. No false positives for valid code

## Test Cases

```javascript
// Should FAIL: addBody doesn't exist
import { createPresentation } from "ha:pptx";
const pres = createPresentation();
pres.addBody([textBox({...})]); // ERROR: addBody not on PresentationBuilder

// Should PASS: addSlide exists
import { createPresentation, textBox } from "ha:pptx";
const pres = createPresentation();
pres.addSlide("", textBox({...})); // OK

// Should FAIL: solidFill not exported (already works)
import { solidFill } from "ha:pptx"; // ERROR: solidFill not exported

// Should PASS: gradientFill exported
import { gradientFill } from "ha:pptx"; // OK
```

---

## Limitations

1. **Type inference is limited** - Only tracks simple `const x = func()` patterns
2. **No flow analysis** - Can't track types through conditionals
3. **No generics** - Can't handle `Array<T>.map()` patterns
4. **Requires JSDoc** - Modules must document `@returns {Type}`

These limitations are acceptable because:
- Most handler code is simple sequential patterns
- The goal is catching common mistakes, not full type checking
- TypeScript would be overkill for sandbox handlers

---

## Future Phases

### Phase 2: Parameter Shape Validation ✅ IMPLEMENTED

**Problem:** LLM passes wrong parameters to functions:
```javascript
textBox({ x: 0, y: 0 });  // Missing required: w, h, text
embedImage(pres, data);   // Missing required: opts object
```

**Implementation (completed 2026-03-11):**
1. Add `required: bool` to ParamInfo in metadata.rs
2. Detect `[name]` optional syntax in JSDoc (vs required `name`)
3. Extract params with required info in ExportSummary
4. Count arguments in function calls
5. Validate required parameters are present

**Error message:**
```
Function 'textBox' requires 5 argument(s) but got 2. Missing: w, h, text
```

### Phase 3: Return Type Validation ✅ IMPLEMENTED

**Problem:** LLM ignores return values or uses them incorrectly:
```javascript
const result = blankSlide(pres);  // blankSlide returns void
result.addBody([...]);  // ERROR: can't use void as value

exportToFile(pres, "out.pptx");  // Returns Promise<void>
const bytes = exportToFile(...);  // ERROR: can't use void as bytes
```

**Implementation (completed 2026-03-11):**
1. Extract `@returns {void}` from JSDoc in metadata.rs
2. Track which functions return void via `ExportSummary.returns_type`
3. Detect `const x = voidFunction()` assignments
4. Emit warning: "Function 'blankSlide' returns void but result is assigned to 'result'"

**Warning message:**
```
Function 'blankSlide' returns void but result is assigned to 'result'. This value cannot be used.
```

### Phase 4: Advanced Type Tracking ✅ IMPLEMENTED

**Problem:** Complex patterns the simple tracker misses:
```javascript
// Chained calls
const slide = pres.addSlide("", shapes).getSlide(0);

// Conditionals
const x = condition ? createPresentation() : null;
x.addSlide();  // x might be null

// Destructuring
const { addSlide } = pres;
addSlide();  // Lost type context
```

**Approach:** This requires proper AST walking and scope analysis. Consider:
- Using QuickJS to actually execute and probe types
- Adding optional swc_ecma_parser for AST analysis
- Both require significant no_std adaptation work

**Implementation (completed 2026-03-11):**
1. **Method chain type propagation** - Track return types through each `.method()` call
2. **If-guard detection** - Recognize `if (x)` and `if (x !== null)` patterns, mark variables as non-nullable in guarded scopes
3. **Property access validation** - Validate `obj.prop` against class properties and methods
4. **Destructuring validation** - Extract destructured variables and validate against source object's available members

**Limitations (documented):**
- Destructuring extracts renamed names, not original property names
- Complex conditional logic (else branches, nested ifs) not fully tracked
- Method chains only work when return types are documented

---

## Validation Roadmap Summary

| Phase | Scope | Priority | Complexity | Status |
|-------|-------|----------|------------|--------|
| **1** | Method existence | Critical | Medium | ✅ Implemented |
| **2** | Required parameters | High | Medium | ✅ Implemented |
| **3** | Return type usage | Medium | Medium | ✅ Implemented |
| **4** | Advanced type tracking | Medium | High | ✅ Implemented |

All phases now complete. Validation is called **transparently** by `register_handler`.

---

## Summary

The core insight is that we already have most of the infrastructure:
- Module sources are resolved and passed to validator ✅
- JSDoc parsing exists in guest for export extraction ✅
- QuickJS is available in the validator ✅
- All parsing happens in no_std guest ✅

**Validation is called transparently by `register_handler`** — no separate LLM tool call required.

**Phase 1 (Method existence) implementation:**
1. Extract class methods from module source (add to `metadata.rs`) ✅
2. Pass structured metadata alongside source (update host flow) ✅
3. Track variable types through simple assignment (add to `validator.rs`) ✅
4. Validate method calls against class metadata (add to `validator.rs`) ✅

**Phase 2 (Parameter validation) implementation:**
1. Add `required: bool` to ParamInfo in metadata.rs ✅
2. Update parse_param_tag to detect `[name]` optional syntax ✅
3. Add params to ExportSummary in validator.rs ✅
4. Implement validate_function_call_params ✅
5. Wire up in validate_javascript flow ✅

**Phase 3 (Void return validation) implementation:**
1. Extract `@returns {void}` from JSDoc ✅
2. Track void-returning functions ✅
3. Warn on `const x = voidFunction()` ✅

**Phase 4 (Advanced type tracking) implementation:**
1. Method chain type propagation ✅
2. If-guard detection for nullable variables ✅
3. Property access validation ✅
4. Destructuring validation ✅

This is a focused enhancement, not a rewrite. The validation flow stays the same, we just add richer metadata and use it.
