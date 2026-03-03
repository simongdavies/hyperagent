# Hyperagent Backlog 📋

Design and architecture changes that need further investigation before
implementation. Items here came from LLM-session feedback and tune-cycle
analysis. None should be attempted without a design plan reviewed by
the team.

---

## B-01: `readBinary()` CPU Explosion on Image Fetch — FIXED

**Source:** Session feedback #3
**Severity:** ~~High~~ → **Resolved**
**Status:** FIXED in commit 3ad2a30

**Root cause:** `readBinary()` was returning `{data: Buffer, done: bool}` — a nested
Buffer. The hyperlight-js NAPI layer base64-encodes nested Buffers (through the
`__buffer__` marker path) because serde_json has no binary type. This added 33%
size inflation + encode/decode CPU overhead on every chunk.

**Fix applied:**
- `readBinary()` now returns Buffer as top-level value (uses fast binary sidecar)
- Empty Buffer (length 0) signals "all data read" instead of `{done: true}`
- Added `fetchBinary()` convenience function that does GET + all reads in one call
- System message updated to direct LLMs to use `fetchBinary()` for images

---

## B-02: `registerHandlers` (Plural / Batch) API

**Source:** Session feedback #4, #8
**Severity:** Medium — auto-save/restore mitigates but doesn't eliminate pain
**Description:**
Registering or updating ANY handler recompiles ALL handlers and destroys
module-level state. The auto-save/restore for `ha:shared-state` mitigates
data loss, but the full recompile still takes time and resets any other
module-level variables. A batch registration API that compiles multiple
handlers in a single atomic operation would avoid repeated rebuilds.

**Investigation needed:**
- Evaluate whether `ProtoJSSandbox` can accept multiple handler registrations
  before triggering a single compile
- Design the tool API: `registerHandlers([{name, code}, ...])` vs
  `registerHandler` with a `batch: true` flag + `commitBatch()` call
- Consider whether an incremental compile mode is feasible in hyperlight-js

---

## B-03: Fetch Data Budget Reset Timing

**Source:** Session feedback #7
**Severity:** Medium — workaround is to restart the session
**Description:**
After exhausting the data budget on failed image fetches, reconfiguring
the fetch plugin via `manage_plugin` didn't reset the per-session budget
counter. The rate limiter is recreated when the sandbox rebuilds, but
the rebuild happens on the *next message turn*, not immediately. If the
LLM reconfigures and then retries in the same turn, the old rate limiter
(with exhausted budget) is still active.

**Investigation needed:**
- Confirm the exact timing: does the sandbox rebuild happen between tool
  calls within a single LLM turn, or only between user messages?
- Consider adding an explicit `resetRateLimiter()` call that `manage_plugin`
  can invoke immediately when reconfiguring
- Alternatively, document clearly that budget reset requires a new message

---

## B-04: `fetchJSON` Error Convention (Follow-Up) — RESOLVED

**Source:** Session feedback #6 (partial fix applied)
**Severity:** ~~Low~~ → **Resolved**
**Status:** Decision implemented - option 2 is final

**Decision:** Keep the two-tier convention:
- `fetchJSON()` / `fetchBinary()` — convenience functions THROW on all errors (including 429)
- `get()` / `post()` / `read()` — low-level functions return `{error: "..."}` objects

This gives LLMs simple error handling for the common case (just catch exceptions)
while preserving flexibility for advanced use cases that need to inspect error details.

**Recent fix (this session):** 429 responses now throw instead of returning error
objects, making the return type consistent (always the expected data type or throw).

---

## B-06: Large Tool Output Handling (SDK Truncation)

**Source:** Production observation — 25.7KB and 56.1KB outputs truncated
**Severity:** Medium-High — LLM loses visibility into tool results
**Description:**
The VS Code Copilot SDK truncates large tool output (threshold ~20KB) and
writes it to a temp file, returning a suggestion to use grep/view_range.
We intentionally disable all built-in file/terminal tools for security
(sandbox model), so the LLM has **no recovery path** — it cannot read
the truncated output. This means the LLM is completely blind to any
tool result exceeding the threshold.

**Proposed solution:** Scoped output directory + controlled fs-read.
1. Detect when result payload exceeds a safe threshold (e.g. 15KB)
2. Write full result to a known output dir (e.g. `/tmp/hyperagent-output/`)
3. Return a summary to the LLM: `{ summary, outputFile, truncated: true }`
4. Provide a scoped read-only tool restricted to that output directory
5. LLM can read full results without access to arbitrary filesystem paths

**Investigation needed:**
- Determine exact SDK truncation threshold (observed ~20KB, undocumented)
- Design the scoped fs-read tool: separate tool or method on sandbox tool?
- Binary data handling (PPTX zip bytes etc.) — write to disk, return metadata only
- Cleanup strategy for temp output files (TTL, session end, explicit cleanup)
- Consider `createSandboxTool({ outputDir, maxInlineOutputBytes })` config

**Why not just truncate?** We don't know the exact threshold, truncation
loses data, and the LLM may need the full result for follow-up actions.

---

## B-07: `list_agents` / `read_agent` SDK Tools — Not Relevant

**Source:** Exploration session — researching whether we should use these
**Severity:** N/A — informational
**Description:**
`list_agents` and `read_agent` are **background sub-agent orchestration tools**
in the Copilot SDK, NOT discovery or chat participant routing tools.

- `list_agents` — lists spawned background agents (`include_completed?: boolean`)
- `read_agent` — reads results from a background agent by `agent_id`,
  with optional `wait` (boolean) and `timeout` (max 300s, default 10s)

The flow is: LLM spawns an agent with `mode: "background"` → gets back
an `agent_id` → uses `read_agent` to poll/wait → uses `list_agents` to
see all running/completed agents.

HyperAgent's sandbox model is synchronous — `execute_javascript` runs
and returns. There's no concept of spawning background agents.
**No action needed.**

---

## B-08: Verify `--skill` Works in Interactive Mode (Without `--prompt`)

**Source:** Manual testing observation
**Severity:** Low — unclear if this is broken or just untested
**Description:**
The `--skill` flag is currently only exercised in the non-interactive
`--prompt` code path (agent.ts, inside `if (cli.prompt) { ... }`). If a
user runs `just start --skill pptx-expert` without `--prompt`, the skill
may never be invoked — it would drop straight into the interactive REPL
without loading skill instructions.

**Investigation needed:**
- Test: `just start --skill pptx-expert` (no `--prompt`) — does the skill
  load before the first interactive prompt?
- If not, add skill invocation to the interactive startup path
- Consider whether `--skill` without `--prompt` should pre-load the skill
  context so the first user message benefits from it

---

## B-05: LLM Uses Training Data Instead of Fetching Research

**Source:** Tune cycle observation (cycles 1-5)
**Severity:** Low — presentation content is fine, but research mode untested
**Description:**
All 5 tune cycle prompts told the LLM "Use the pptx-expert skill" but
did not specify any URLs or data sources to fetch.  The LLM correctly
used its training data to generate content, but this means we never
exercised the two-handler research+build pattern or the fetch plugin.

**Action:**
Future tune prompts should include specific URLs (e.g. GitHub API,
public JSON endpoints) so the LLM is forced to use the research handler
pattern and we can validate fetch + shared-state + build integration.

---

## B-06 (second): LLM Skips module_info Before Writing Handler Code — FIXED

**Source:** Tune cycle 4 crash — `blankSlide` returns void, LLM assumed object
**Severity:** ~~Medium~~ → **Resolved**
**Status:** FIXED

**Fix applied:**
- System prompt: removed detailed PPTX API listings, replaced with
  short module directory + mandatory module_info rule
- SKILL.md: added "MANDATORY: Call module_info Before Writing Code"
  section with minimum required calls before register_handler
- Moved PPTX Colour Rules and Data Rules from system prompt to SKILL.md
  (domain-specific rules belong with the domain-specific skill)

---

---

## B-09: Add Line Ranges to `get_handler_source` — DONE

**Source:** Handler editing gap analysis
**Severity:** ~~Medium~~ → **Resolved**
**Status:** IMPLEMENTED

Added `startLine` and `endLine` optional parameters to `get_handler_source`.
Returns `totalLines` in response metadata. Line numbers are 1-based.
Output includes line numbers by default (format: `  1 | code...`).

---

## B-10: Add `edit_handler` Tool (Surgical Edits) — DONE

**Source:** Handler editing gap analysis
**Severity:** ~~High~~ → **Resolved**
**Status:** IMPLEMENTED

New tool `edit_handler(name, oldString, newString)`:
- Matches `oldString` exactly once (errors on 0 or 2+ matches)
- Replaces with `newString`, recompiles handler
- Returns edited region with 3 lines of surrounding context
- Added to tool gating (ALLOWED_TOOLS + availableTools)

---

## B-11: Add `list_handlers` Tool — DONE

**Source:** Handler editing gap analysis
**Severity:** ~~Low~~ → **Resolved**
**Status:** IMPLEMENTED

New tool `list_handlers()` returns array of registered handler names
with metadata (line count). Excludes internal handlers (underscore prefix).

---

## B-12: Add Line Numbers to Handler Source Output — DONE

**Source:** Handler editing gap analysis
**Severity:** ~~Low-Medium~~ → **Resolved**
**Status:** IMPLEMENTED (merged into B-09)

Line numbers are now included by default in `get_handler_source` output.
Format: right-aligned numbers with pipe separator (`  1 | const x = ...`).
Response includes `totalLines` metadata.

---

## B-13: PPTX Theme Discovery via Runtime Error — FIXED

**Source:** Session feedback — LLM tried `theme: "midnight"`, got error listing valid themes
**Severity:** ~~Low~~ → **Resolved**
**Status:** FIXED

**Fix applied:**
- Added `getThemeNames` import from `ha:ooxml-core` to `ha:pptx`
- Re-exported `getThemeNames()` from `ha:pptx` for LLM convenience
- Updated `_HINTS` to mention `getThemeNames()` prominently at top
- Added missing 'black' theme to documentation (was in code but not listed)

---

## B-14: `forceAllColors` Presentation-Level Doesn't Suppress Per-Element Checks — FIXED

**Source:** Session feedback — even with `forceAllColors: true`, individual
elements still need `forceColor: true` for explicit color overrides
**Severity:** ~~Low-Medium~~ → **Resolved**
**Status:** FIXED

**Fix applied:**
- Updated `textBox`, `rect`, and `statBox` to check `_forceAllColors` flag
- Now `createPresentation({forceAllColors: true})` truly bypasses ALL contrast validation
- No per-element `forceColor: true` needed when global flag is set

---

## B-15: Layout Helpers for Common Slide Patterns — DONE

**Source:** Session feedback — "3 stat boxes in a row" requires manual x/y/w/h
**Severity:** ~~Medium~~ → **Resolved**
**Status:** IMPLEMENTED

**Implemented helpers:**
- `layoutColumns(count, {margin, gap, y, h})` — equal-width columns
- `layoutGrid(count, {cols, margin, gap, y, maxH})` — grid of items
- `overlay({opacity, color})` — dark overlay for image slides
- `SLIDE_WIDTH_INCHES` (13.333) and `SLIDE_HEIGHT_INCHES` (7.5) constants

Example usage:
```javascript
const cols = layoutColumns(3, { margin: 0.5, gap: 0.25, y: 2, h: 3 });
statBox({...cols[0], value: '100', label: 'Users'});
statBox({...cols[1], value: '50%', label: 'Growth'});
statBox({...cols[2], value: '4.8', label: 'Rating'});
```

---

## B-16: Batch Image Download in Fetch Plugin — DONE

**Source:** Session feedback — research → find images → download requires 3+ handlers
**Severity:** ~~Medium~~ → **Resolved**
**Status:** IMPLEMENTED

**Implementation:**
- Added `fetchBinaryBatch(urls)` to fetch plugin
- Takes array of URLs, returns array of `{url, data}` or `{url, error}` objects
- Sequential downloads to respect rate limits
- Best-effort: continues on individual failures, returns partial results
- Does NOT throw — check each result's `error` field

**Usage:**
```javascript
import * as fetch from "host:fetch";
const results = fetch.fetchBinaryBatch([url1, url2, url3]);
for (const r of results) {
  if (r.error) console.log(`Failed: ${r.url} - ${r.error}`);
  else embedImage(pres, { data: r.data, format: "jpg", ... });
}
```

---

## ~~B-17: Fetch Plugin Preset Configurations~~ RESOLVED

**Resolution:** Implemented preset expansion in `plugins/fetch/index.js`. Three presets are now available:
- `"text-only"` — application/json, text/, application/xml, application/csv
- `"media-friendly"` — text-only + image/, audio/, application/pdf
- `"permissive"` — empty prefix matches any content type

Usage: `/plugin enable fetch allowedContentTypes=[media-friendly]`

Presets can be mixed with explicit types: `allowedContentTypes=[text-only,video/]`

---

## B-18: Shared State Persistence Across Handler Edits — INVESTIGATION NEEDED

**Source:** Session feedback — image downloads wiped on handler registration
**Severity:** Medium — forces redundant re-downloads
**Description:**
`ha:shared-state` module survives recompiles, but the workflow creates uncertainty:
download images → store in state → register builder handler → state may or may not survive.
The actual behavior is that shared-state DOES survive, but the user experience is confusing.

**Investigation needed:**
- Document the exact save/restore lifecycle clearly in system message
- Consider adding a persistent binary cache for downloaded assets
- Consider caching downloaded images at the host level (keyed by URL) to avoid re-downloads

---

## B-19: Handler Code Size Limits for Large Presentations

**Source:** Session feedback — 23-slide deck required ~27KB monolithic handler
**Severity:** Low — workaround exists (incremental building)
**Description:**
Large presentations hit handler code size limits. The workaround is incremental building
(create pres, add slides in batches, export), but this is fragile if handler edits
wipe module-level state.

**Proposed solution:**
- Batch slide-building helper: `addSlidesFromTemplate(pres, template, dataArray)`
- Better documentation of incremental building patterns

---

## B-20: backgroundImage() Validation Was Broken — FIXED

**Source:** Session feedback — function always threw "first parameter must be presentation object"
**Severity:** ~~High~~ → **Resolved**
**Status:** FIXED

**Root cause:** Validation checked for `pres.embedImage` which doesn't exist.
`embedImage` is a standalone function, not a method on the pres object.

**Fix applied:** Changed validation to check `pres.theme` instead.

---

## B-21: Dark Themes Auto-Enable forceAllColors — DONE

**Source:** Session feedback — brutalist theme required explicit forceAllColors:true
**Severity:** ~~Low~~ → **Resolved**
**Status:** IMPLEMENTED

Dark themes (isDark: true) now automatically enable forceAllColors to bypass
WCAG contrast validation. This prevents the common error of explicit colors
failing contrast checks against dark backgrounds.

---

## B-22: Fetch Data Budget Increased — DONE

**Source:** Session feedback — 512KB budget too tight for image-heavy decks
**Severity:** ~~Medium~~ → **Resolved**
**Status:** IMPLEMENTED

Default `maxDataReceivedKb` increased from 512KB to 2048KB (2MB).
Maximum allowed increased from 2048KB to 4096KB (4MB).

---

## B-23: Default Background Color in createPresentation — DONE

**Source:** Session feedback — every customSlide needs `background: '0A0A0A'` for dark themes
**Severity:** ~~Low~~ → **Resolved**
**Status:** IMPLEMENTED

Added `defaultBackground` option to `createPresentation()`:
- String for solid color: `defaultBackground: '0A0A0A'`
- Object for gradient: `defaultBackground: {color1: '000000', color2: '1a1a2e', angle: 180}`

Slides created via `addBody()` now use: per-slide background > defaultBackground > theme.bg

---

## B-24: Slide Templates Module — DONE

**Source:** Session feedback — "pre-built layouts would cut code by 60%"
**Severity:** ~~Medium~~ → **Resolved**
**Status:** IMPLEMENTED

Added four high-level slide templates to `ha:pptx`:

```javascript
// Hero slide with full-bleed image
heroSlide(pres, {
  image: imgData,  // Uint8Array from fetchBinary
  title: "Big Bold Title",
  subtitle: "Supporting text",
  overlayOpacity: 0.5
});

// Stat grid (2-4 metrics in a row)
statGridSlide(pres, {
  title: "Key Metrics",
  stats: [
    { value: "10M+", label: "Users" },
    { value: "99.9%", label: "Uptime" }
  ]
});

// Image grid (2-6 images)
imageGridSlide(pres, {
  title: "Gallery",
  images: [img1, img2, img3, img4]
});

// Quote/testimonial
quoteSlide(pres, {
  quote: "This changed everything.",
  author: "Jane Smith",
  role: "CEO, TechCorp"
});
```

All templates are theme-aware — colors adapt to the active theme automatically.

---

## B-25: Gradient Slide Backgrounds — DONE

**Source:** Session feedback — "gradient backgrounds would add visual depth"
**Severity:** ~~Low~~ → **Resolved**
**Status:** IMPLEMENTED

- Exported `gradientBg(color1, color2, angle)` for use with `pres.addSlide()`
- `addBody()` now accepts gradient spec: `{background: {color1, color2, angle}}`
- Uses same OOXML `<a:gradFill>` structure as shape gradients

---

## B-26: Presentation Builder Pattern (Cross-Handler Pres Objects) — DONE

**Source:** Session feedback — "pres object has methods, can't store in shared-state"
**Severity:** ~~Medium~~ → **Resolved**
**Status:** IMPLEMENTED

Added `pres.serialize()` and `restorePresentation(state)`:

```javascript
// Handler 1: Create
const pres = createPresentation({ theme: "brutalist" });
titleSlide(pres, { title: "Hello" });
embedImage(pres, { data: imgBytes, format: "jpg", ... });
sharedState.set("pres", pres.serialize());

// Handler 2: Continue (images preserved!)
const pres = restorePresentation(sharedState.get("pres"));
contentSlide(pres, { title: "More content" });
sharedState.set("pres", pres.serialize());

// Handler 3: Export
const pres = restorePresentation(sharedState.get("pres"));
writeFileBinary("output.pptx", pres.buildZip());
```

Serialized state includes: theme, defaultBackground, forceAllColors, slides, images (Uint8Array), charts.

---

## B-27: readFile Binary Mode — ALREADY IMPLEMENTED

**Source:** Session feedback — "readFile returns string, .length reports character count"
**Severity:** ~~Low~~ → **Resolved**
**Status:** ALREADY EXISTS

**Discovery:** The fs-read plugin already provides native binary functions:
- `readFileBinary(path)` — Returns `Uint8Array` directly, no base64 overhead
- `readFileChunkBinary(path, offset, length)` — Chunked binary reads

These return byte count via `.length` as expected. The systemMessage documents
this prominently under "Read operations (native binary — preferred for binary files)".

No changes needed — the feature already exists.

---

## B-28: Rich Font System

**Source:** Session feedback — "limited to system fonts, no custom typography"
**Severity:** Low — aesthetic limitation
**Description:**
PPTX files can embed fonts, but hyperagent only supports system fonts.
For brutalist/modern designs, condensed and impact fonts would help.

**Investigation needed:**
- OOXML font embedding format (complex — requires subset extraction)
- Alternative: expand safe font list to include more expressive options
- Web fonts? (would require network access and licensing concerns)

---

## B-29: `pres.theme` Property Access Rejected by Validator

**Source:** Session feedback (2026-03-14)
**Severity:** Medium — documented feature doesn't work
**Description:**
The `_HINTS` says `pres.theme — access the active theme object`, but the validator
rejects `pres.theme` as not existing on `PresentationBuilder`. The workaround is
importing `getTheme` from `ha:ooxml-core` separately.

**Root cause:** The metadata extraction (`extractFactoryClasses`) creates a synthetic
class `PresentationBuilder` with methods from JSDoc, but doesn't include properties.
The `.d.ts` has `interface Presentation { theme: Theme; ... }` but isn't used for
validation metadata.

**Fix options:**
1. Parse `.d.ts` files for interfaces and extract properties (proper fix)
2. Add property extraction to JSDoc parser (look for `get X()` or direct assignments)
3. Hardcode known properties for `PresentationBuilder` in test fixtures (band-aid)

**Acceptance:** `pres.theme` should not trigger validation error when `pres = createPresentation()`.

---

## B-30: Image Fetching Counts Against CPU Time

**Source:** Session feedback (2026-03-14)
**Severity:** Medium — 8 images used 94% of CPU timeout (14s of 15s)
**Description:**
Downloading images via `fetchBinaryBatch` counts against CPU time even though
it's I/O-bound waiting. This limits image-heavy presentations.

**Fix options:**
1. Increase default CPU timeout for profiles using fetch
2. Move fetch operations to wall-clock time instead of CPU time (Hyperlight change)
3. Document limitation and recommend pre-fetching in separate handlers

---

## ~~B-31: No HEAD Request Capability~~ RESOLVED

**Resolution:** Added `fetch.head(url)` function that performs HEAD requests without
downloading body. Returns `{status, ok, contentType, contentLength?}`. Useful for
verifying URLs exist before batch downloads.

---

## ~~B-32: Template Literal Safety for Shape Composition~~ RESOLVED

**Resolution:** Added `shapes()` helper function in ha:pptx that safely combines
shape XML fragments. It validates each item and throws clear errors if objects
without proper `toString()` are passed (like `[object Object]`).

Usage:
```javascript
customSlide(pres, {
  shapes: shapes([
    textBox({ x: 1, y: 1, w: 10, h: 1, text: 'Title' }),
    embedChart(pres, chart, { x: 1, y: 2, w: 10, h: 4 }),
    rect({ x: 1, y: 6.5, w: 10, h: 0.5, fill: 'FF0000' })
  ])
});
```

This is safer than string concatenation because it catches invalid values
before they corrupt the XML.

---

## B-33: fetchBinaryBatch Automatic Retry with Backoff — DONE

**Source:** Session feedback (2026-03-14)
**Severity:** ~~Low-Medium~~ → **Resolved**
**Status:** IMPLEMENTED

Added automatic retry with exponential backoff for 429/503 responses:
- Default 1 retry attempt, configurable via `options.maxRetries`
- Respects `Retry-After` header if present, else uses exponential backoff
- Base delay 1000ms, configurable via `options.baseDelayMs`

---

## B-34: fetchJSON Size Limit — DONE

**Source:** Session feedback (2026-03-14)
**Severity:** ~~Low~~ → **Resolved**
**Status:** IMPLEMENTED

Increased `MAX_JSON_BYTES` from 512KB to 1MB. Larger responses should use
the streaming `get()` + `read()` pattern.

---

## B-35: Import Syntax Discovery — DONE

**Source:** Session feedback (2026-03-14)
**Severity:** ~~Low~~ → **Resolved**
**Status:** IMPLEMENTED

Added `importStyle` field to module.json: `"named"` or `"namespace"`.
- Most modules use `"named"` → `import { x, y } from "ha:module"`
- `shared-state` uses `"namespace"` → `import * as sharedState from "ha:shared-state"`

`module_info` now returns dynamic `importAs` based on this field.

---

## B-36: fs-write Error Should Suggest exportToFile — DONE

**Source:** Session feedback (2026-03-14)
**Severity:** ~~Low~~ → **Resolved**
**Status:** IMPLEMENTED

Error message for `writeFileBinary` size limit now suggests `exportToFile`
when the filename ends in `.pptx`, `.xlsx`, or `.docx`.

---

## B-37: embedChart Position API — DONE

**Source:** Session feedback (2026-03-14)
**Severity:** ~~Low~~ → **Resolved**
**Status:** IMPLEMENTED

`embedChart(pres, chart, pos)` now accepts position from either:
1. The `pos` argument: `embedChart(pres, chart, {x:1, y:2, w:8, h:5})`
2. The chart object: `embedChart(pres, {...barChart(...), x:1, y:2})`

Position argument takes precedence; chart object position is fallback.

---

## B-38: Validator False Positives for Options Object Pattern — DONE

**Source:** Session feedback (2026-03-14)
**Severity:** ~~High~~ → **Resolved**
**Status:** FIXED

**Problem:** The static validator rejected valid code like `rect({x:0, y:0, w:13, h:7.5, fill:'0A0A0A'})`
claiming "requires 6 arguments but got 1" — it was counting `opts.x`, `opts.y`, etc. as separate
positional arguments instead of recognizing them as properties of a single options object.

**Root cause:** JSDoc documents options objects as:
```
@param {Object} opts
@param {number} opts.x
@param {number} opts.y
```
The validator was treating each `@param` as a separate required positional argument.

**Fix:** Updated `validate_function_call_params` in validator.rs to filter out params with `.` in
their name when counting required arguments. Params like `opts.x` are properties of `opts`, not
separate positional args.

---

## B-39: URL Length Limit Not Documented — DONE

**Source:** Session feedback (2026-03-14)
**Severity:** ~~Low~~ → **Resolved**
**Status:** FIXED

**Problem:** Batching 15 Wikipedia API titles hit "path+query too long" with no indication of limits.
LLM had to discover by trial and error that path+query is limited.

**Fix applied:**
- Error messages now include actual vs limit: `"path+query too long (1234 > 1024 chars)"`
- Added "URL Length Limits" section to fetch plugin header documenting:
  - Total URL: 2048 characters maximum
  - Path + query string: 1024 characters maximum

---

## B-40: pptx-tables and pptx-charts @param Descriptions Minimal — DONE

**Source:** Session feedback (2026-03-14)
**Severity:** ~~Low~~ → **Resolved**
**Status:** FIXED

**Problem:** Functions like `comparisonTable`, `table`, `kvTable`, `barChart` had minimal
`@param opts - Options` descriptions that didn't reveal required fields.

**Fix applied:** Updated all `.d.ts` files with expanded @param descriptions that list required
and optional fields inline:
```
@param opts - REQUIRED: { features: string[], options: Array<{name, values}> }. Optional: x?, y?, w?, theme?, style?
```

---

## B-41: shared-state API Names in Type Declarations — FIXED

**Source:** Session feedback (2026-03-14) — "shared-state API discovery"
**Severity:** ~~Medium~~ → **Resolved**
**Status:** FIXED

**Problem:** LLM guessed `getState/setState` which doesn't exist. The actual API is
`get/set` from `ha:shared-state`. The type declaration in `ha-modules.d.ts` was wrong —
it declared `getState/setState/deleteState/hasState/clearState` but the actual module
exports `get/set/del/has/clear`.

**Root cause:** The d.ts file was hand-written and never updated when the
actual shared-state.ts implementation used shorter names.

**Fix applied:**
1. Created `scripts/generate-ha-modules-dts.ts` to auto-generate `ha-modules.d.ts`
   from the compiled `.d.ts` files
2. Added generator to `npm run build:modules` pipeline
3. Added test in `dts-sync.test.ts` that verifies declared exports match actual exports
4. Now impossible for declarations to drift from implementation

---

## B-42: Output Buffer Truncation for Large Results

**Source:** Session feedback (2026-03-14) — "Image URL truncation"
**Severity:** Medium — forces workaround handlers
**Description:**
Wikipedia's media-list API returned >21KB which got truncated by the output buffer.
LLM had to register a second handler just to parse and extract needed data.

**Relation to B-06:** This is related to the SDK truncation issue (B-06) but is
about the hyperlight output buffer, not the SDK. The 1040KB default should be
plenty, but if the result includes verbose JSON, it fills quickly.

**Proposed solutions:**
1. Increase default output buffer size (currently 1040KB)
2. Add result streaming/pagination capability
3. Add helper to auto-extract and store relevant fields in shared-state
4. Better documentation of buffer limits

---

## ~~B-43: Handler Recompilation Friction Documentation~~ RESOLVED

**Resolution:** Documentation added in three places:
1. **System message** (`agent/system-message.ts`): Added explicit warning about recompilation and the fetch-first workflow pattern
2. **SKILL.md** (`skills/pptx-expert/SKILL.md`): Enhanced "Updating Handler Code" section with consequences and workflow pattern
3. **shared-state _HINTS** (`builtin-modules/src/shared-state.ts`): Added prominent warning and correct/incorrect pattern examples

---

## B-44: fetchWithCache Auto-Store Pattern

**Source:** Session feedback (2026-03-14) — "fetchWithCache suggestion"
**Severity:** Low — convenience feature
**Description:**
A `fetchWithCache` that auto-stores results in shared-state would eliminate the
download → store → retrieve dance across handlers.

**Proposed API:**
```javascript
// Auto-stores result in shared-state with key based on URL hash
const img = fetchBinaryWithCache(url);  // Returns Uint8Array
// OR
const img = get(`fetch:${urlHash}`);  // Retrieve from cache
```

**Alternative:** Document the manual pattern well enough that it's easy to follow.

---

## B-45: Font Size Limit Increased to 400pt — DONE

**Source:** Session feedback (2026-03-14) — "fontSize: 220 exceeds the maximum 200"
**Severity:** ~~Low~~ → **Resolved**
**Status:** IMPLEMENTED

**Problem:** LLM wanted 220pt for dramatic keynote-style slides but hit the 200pt cap.

**Fix applied:** Increased `max` in all fontSize validation from 200 to 400pt.
This affects: textBox, rect, bulletList, numberedList, statBox, circle, callout,
icon, richText, hyperlink, codeBlock.

---

## B-46: `bigNumberSlide` Template for Keynote-Style Presentations

**Source:** Session feedback (2026-03-14) — "Slide templates for Elon-style presentations"
**Severity:** Low — convenience feature
**Description:**
For dramatic "one big number + label" slides (like "2.6 SECONDS" or "350 MILES"),
LLM has to manually position textBoxes. A dedicated template would simplify this.

**Proposed API:**
```javascript
bigNumberSlide(pres, {
  number: '2.6',
  unit: 'SECONDS',
  footnote: '0-60 MPH',
  numberColor: 'FF0000',  // optional
  background: '000000'     // optional
});
```

**Design notes:**
- Number should be massive (120-180pt), centered vertically
- Unit/label smaller (28-36pt), below the number
- Optional footnote even smaller (18pt) at bottom
- Should work with dark backgrounds by default

---

## B-47: Wikipedia mobile-sections API 403 Error

**Source:** Session feedback (2026-03-14) — "mobile-sections endpoint returned HTTP 403"
**Severity:** Low — informational, not a bug in hyperagent
**Description:**
Wikipedia's `/api/rest_v1/page/mobile-sections/` endpoint returns 403 for some requests.
LLM had to fall back to the MediaWiki action API (`/w/api.php?action=parse`).

**Action:** Document this in pptx-expert SKILL.md as a known limitation when
researching Wikipedia content. Suggest using the action API or `/page/summary/`
endpoint which are more reliable.

---

## B-48: ZIP Duplicate Entry Deduplication — FIXED

**Source:** Session feedback (2026-03-14) — Tesla_Cybertruck_Launch.pptx invalid format
**Severity:** ~~High~~ → **Resolved**
**Status:** FIXED

**Root cause:** When presentations with images are serialized/restored across handlers,
the `_images` array could accumulate duplicate entries with the same `mediaPath`.
The `createZip()` function wrote all entries without deduplication, resulting in
ZIP files with duplicate file entries (e.g., `ppt/media/image5.jpg` appearing twice).
Most ZIP readers (including PowerPoint) reject or mishandle such files.

**Fix applied:**
- `createZip()` in `zip-format.ts` now deduplicates entries by name (last entry wins)
- `contentTypesXml()` in `ooxml-core.ts` now deduplicates overrides by partName
- Added regression test for ZIP deduplication behavior

---

## B-49: Image Fit Mode for embedImage — DONE

**Source:** Session feedback (2026-03-14) — "LLM stretching images to fit"
**Severity:** ~~Medium~~ → **Resolved**
**Status:** DONE

**Problem:** Images embedded with `embedImage()` were always stretched to fill the
specified bounds, distorting aspect ratios. Users wanted CSS-like `contain`/`cover`
behavior.

**Fix applied:**
- Added `fit` option to `embedImage()`: `'stretch'` (default), `'contain'`, `'cover'`
- Added `getImageDimensions()` export to read PNG/JPEG/GIF/BMP header bytes
- Uses OOXML `<a:srcRect>` for cropping (cover) and `<a:fillRect>` for padding (contain)
- No pixel manipulation — just header parsing (~30 bytes)

---

## B-50: Presentation-Level Default Text Color — DONE

**Source:** Session feedback (2026-03-14) — "had to specify color on every single text element"
**Severity:** ~~Medium~~ → **Resolved**
**Status:** DONE

**Fix applied:**
- Added `defaultTextColor` option to `createPresentation()`:
  ```typescript
  const pres = createPresentation({
    theme: 'brutalist',
    defaultTextColor: 'FFFFFF',  // Applied to all text unless overridden
  });
  ```
- Updated textBox, bulletList, numberedList, statBox, richText to use defaultTextColor
- Persists across serialize()/restorePresentation()

---

## B-51: Slide Templates / Reusable Layouts

**Source:** Session feedback (2026-03-14) — "repeated the same visual pattern on ~12 slides"
**Severity:** Medium — would cut code by ~40% for consistent decks
**Description:**
Complex presentations often repeat the same layout pattern (e.g., "dark slide with
red section label at top, white bold title, red accent line"). Currently requires
copy-pasting the same shapes on every slide.

**Proposed API:**
```typescript
// Define template once
const darkSection = defineSlideTemplate(pres, {
  background: '0A0A0A',
  elements: [
    { type: 'rect', x: 0, y: 0, w: 13.33, h: 0.8, fill: 'E31937' }, // red bar
    { type: 'textBox', id: 'sectionLabel', x: 0.5, y: 0.2, fontSize: 14 },
    { type: 'textBox', id: 'title', x: 0.5, y: 1.2, fontSize: 44, bold: true },
  ],
});

// Use template with variable content
templateSlide(pres, darkSection, {
  sectionLabel: 'SPECS',
  title: 'Performance Metrics',
  // ... additional content
});
```

**Investigation needed:**
- How to define variable slots vs fixed elements?
- Should templates support arbitrary additional shapes?
- Interaction with existing slide functions (contentSlide, customSlide, etc.)

---

## B-52: Table Per-Cell Styling

**Source:** Session feedback (2026-03-14) — "don't support per-cell coloring or bolding"
**Severity:** Low-Medium — enhancement for data-heavy presentations
**Description:**
`table()`, `kvTable()`, `comparisonTable()` from `ha:pptx-tables` don't support
styling individual cells. Highlighting specific values (e.g., making a "best" column
red) requires workarounds.

**Proposed API:**
```typescript
table({
  data: [
    ['Model', 'Range', 'Price'],
    ['Single Motor', '250mi', { value: '$60,990', style: { color: '00FF00' } }],
    ['Cyberbeast', '320mi', { value: '$99,990', style: { bold: true, color: 'E31937' } }],
  ],
  // ... other options
});
```

**Investigation needed:**
- How to handle mixed string/object cell values?
- Should support row/column-level styling shortcuts?
- Impact on type definitions

---

## B-53: Composite Shape Helpers (panel, card) — DONE

**Source:** Session feedback (2026-03-14) — "darkPanel composite shape for card/panel pattern"
**Severity:** ~~Low~~ → **Resolved**
**Status:** DONE

**Fix applied:**
Added `panel()` and `card()` composite shape functions:

```typescript
// Panel: rounded rect with title + body
shapes += panel({
  x: 1, y: 2, w: 5, h: 3,
  fill: '1A1A1A',
  title: 'Title',
  body: 'Body content...',
  cornerRadius: 8,
});

// Card: panel with accent stripe at top
shapes += card({
  x: 1, y: 2, w: 4, h: 2.5,
  accent: 'E31937',  // Red stripe at top
  title: 'Cyberbeast',
  body: '845 hp tri-motor',
});
```

---

## B-54: Wikimedia Commons Image Search Module

**Source:** Session feedback (2026-03-14) — "Image URL discovery is a 3-step process"
**Severity:** Low — nice-to-have, workarounds exist
**Description:**
Finding images on Wikipedia/Commons requires: (1) media-list API, (2) filter SVGs/icons,
(3) resolve relative URLs. A higher-level module would simplify:

```typescript
import { searchImages } from 'ha:wikimedia';

const images = await searchImages('Tesla Cybertruck', {
  limit: 10,
  minWidth: 800,
  excludeTypes: ['svg', 'logo', 'icon'],
});
// Returns: [{ url, width, height, title, license }, ...]
```

**Investigation needed:**
- Wikimedia Commons API capabilities and rate limits
- License attribution requirements
- Should this be a host module (needs network) or handler-level helper?

---

## B-55: Text Effects (Glow, Shadow) — DONE

**Source:** Session feedback (2026-03-14) — "text glow effects, gradient text fills, drop shadows"
**Severity:** ~~Low~~ → **Resolved**
**Status:** DONE

**Fix applied:**
Added `glow` and `shadow` options to textBox (via TextEffectOptions interface):

```typescript
// Glow effect
shapes += textBox({
  x: 1, y: 1, w: 5, h: 1,
  text: 'CYBERTRUCK',
  fontSize: 48,
  glow: { color: 'FF0000', radius: 5 },  // Red glow, 5pt radius
});

// Drop shadow
shapes += textBox({
  x: 1, y: 2, w: 5, h: 1,
  text: 'Coming Soon',
  fontSize: 24,
  shadow: { color: '000000', blur: 4, offset: 2, angle: 45, opacity: 0.5 },
});
```

Note: Gradient text fill not implemented (more complex OOXML, lower priority).

---

*Last updated: 2026-03-14*

---

## ~~B-57: Validator Doesn't Check Named Import Existence~~ FIXED

**Source:** Session feedback (2026-03-14) — LLM used `import { setState } from 'ha:shared-state'`
**Severity:** ~~Medium-High~~ → **Resolved**
**Status:** FIXED

**Problem:** The validator checked that the module (e.g., `ha:shared-state`) is available, but didn't
validate that the named import (`setState`) actually exists in that module. The LLM
guessed `setState` based on React conventions instead of the actual `set` export.

**Fix applied:**
- Added `extract_all_named_imports()` function to `js_parser.rs`
- Added validation step 9.5 in `validator.rs` that cross-references named imports against module exports
- Error message now shows: `'setState' is not exported by 'ha:shared-state'. Available exports: set, get, has, del, keys, clear`
- Added unit tests for valid and invalid named imports

---

## B-58: Batch module_info API for Efficient Discovery

**Source:** Session feedback (2026-03-14) — "Batch module discovery API"
**Severity:** Low-Medium — would reduce tool calls during setup
**Description:**
LLM needs to call `module_info` for each module (pptx, pptx-tables, pptx-charts, shared-state)
before writing handler code. A batch version would reduce round-trips:

**Proposed API:**
```
module_info_batch(modules: ['ha:pptx', 'ha:pptx-tables', 'ha:pptx-charts', 'ha:shared-state'])
→ Returns combined info for all requested modules
```

**Alternative:** Include module export summaries in `list_modules` response, reducing the need
for individual `module_info` calls.

---

## ~~B-56: embedChart Returns Object Instead of String~~ FIXED

**Source:** Session feedback (2026-03-14) — `[object Object]` in slide19 XML
**Severity:** High — causes invalid OOXML, PowerPoint refuses to open file
**Root cause:** `embedChart()` returned an object with `{shapeXml, zipEntries, ...}`.
When LLM used it in string concatenation (`textBox(...) + embedChart(...) + rect(...)`),
JavaScript converted the object to `"[object Object]"`, corrupting the XML.

**Fix applied:**
Added `toString()` method to `EmbedChartResult` that returns `shapeXml`.
Now string concatenation works as the LLM expects:
```javascript
shapes: textBox(...) + embedChart(pres, chart, pos) + rect(...)
```

The `embedChart()` result still exposes all properties (`shapeXml`, `zipEntries`, etc.)
for advanced use cases, but implicit string conversion now returns the XML.

---

## B-59: Guidance Dedup / Rationalisation / Contradiction Detection

**Source:** Session feedback (2026-03-19) — multi-skill matching produces bloated guidance
**Severity:** Medium — grows worse as skill library expands
**Description:**
When multiple skills match a prompt (e.g., "research the API endpoints and build a report"
→ research-synthesiser + api-explorer + report-builder), `resolveApproach` unions all
rules, antiPatterns, and steps from all matched skills and their patterns. The result has
several quality problems:

1. **No semantic dedup** — near-identical rules from different sources all appear:
   - Skill A: "Don't parse HTML with regex"
   - Skill B: "Don't use regex to parse HTML — use parseHtml()"
   - Module hint: "Never use string manipulation for HTML parsing"
   All three survive because they're different strings.

2. **No contradiction detection** — conflicting guidance passes through silently:
   - "Use ha:shared-state to pass data between handlers"
   - "Don't use shared-state for payloads > 1MB"
   These aren't true contradictions but there's no logic to reconcile or prioritise.

3. **No context budget** — no cap on total guidance size. Three matched skills can produce
   30+ rules + 30+ antiPatterns + 20+ steps, burning context window on repetitive guidance.

4. **Steps never truly dedup** — steps are prefixed with `[patternName]`, so the same
   conceptual step from two different patterns (shared by different skills) appears twice.

5. **No priority ordering** — rules from the primary skill, secondary skills, module hints,
   and pattern steps all merge flat with no precedence hierarchy.

**Current dedup mechanisms:**
- `Set<string>` for modules, plugins, profiles — works perfectly (exact match)
- `Set<string>` for antiPatterns from skills — exact string only
- `!includes()` for module hint rules/antiPatterns — exact string only
- `[...new Set(allRules)]` — exact string dedup on rules
- `extractRules` caps at 10 per skill but no global cap
- `Math.max` per config key — clean, no issues

**Options (increasing complexity):**
1. **Hard budget + truncate** — cap total guidance at N chars, prioritise primary skill
2. **Substring dedup** — if rule A is a substring of rule B, drop A
3. **Normalised dedup** — lowercase + strip punctuation before comparing
4. **Semantic similarity** — embed rules and group by cosine similarity (overkill?)
5. **LLM-assisted consolidation** — ask the LLM to merge/deduplicate (circular?)
6. **Skill-level priority** — highest-scoring skill's rules take precedence; others
   only contribute novel rules not covered by the primary

**Recommendation:** Start with option 1 (hard budget) + option 2 (substring dedup) +
option 6 (primary skill priority). Simple, no external dependencies, measurable improvement.

---

## B-60: Opaque Secret Management for Authenticated APIs

**Source:** Session feedback (2026-03-19) — api-explorer skill limited to public APIs
**Severity:** Medium — blocks authenticated API exploration
**Description:**
The LLM cannot safely handle API keys, tokens, or secrets. Keys would leak into
conversation context, tool call history, compaction summaries, and logs. A proper
secret management system is needed where:

1. **Secrets are opaque** — LLM sees handles (`$GITHUB_TOKEN`) not values
2. **Host resolves** — fetch plugin substitutes real values before HTTP request
3. **Permission model** — explicit (prompt user), domain-scoped, or yolo mode
4. **Audit trail** — host logs which secrets were used for which domains

**Full design:** See `working-docs/SECRET-MANAGEMENT-DESIGN.md`

**Dependencies:** Fetch plugin header injection hook, secret store, CLI UX, approval flow.

**Impact:** Unblocks api-explorer for authenticated APIs, enables OAuth flows,
allows secure integration testing workflows.

---
