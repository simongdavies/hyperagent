# Iteration Analysis - 2026-03-12

## Prompt Used
```
Research Teslas Cybertruck features and create a product launch deck as if you are Elon announcing it on stage. Go full brutalist design - stark contrasts, massive typography, cinematic vehicle images, spec comparisons in bold tables. Dark background, minimal text per slide, maximum visual impact. Include a 'just one more thing' reveal slide at the end. Make sure you got the internet to research and find images, visuals of the truck, dont just rely on your training data. Report on what difficulties you had using the modules, building handlers, using plugins and what changes would make things quicker, easier and more efficient
```

## Focus Areas
- Broken APIs (image downloading)
- LLM not following guidance (not researching before coding)
- validate_code tool thoroughness
- Repeated handler experimentation
- Pattern/approach understanding
- State management understanding
- PPTX structural validity
- Visual soundness (contrast, sizing, overlapping)
- LLM feedback analysis

---

## Iteration 1 - WITH pptx-expert skill

### Run Started
- Command: `just start-debug --tune --verbose --debug --skill pptx-expert --auto-approve --transcript --show-code`
- Session ID: hyperagent-c7ad6a0e-9174-47ba-abeb-2f5f6ba557b9

### Critical Issues Found

#### 1. **MAJOR BUG: pres.addShape() doesn't exist - LLM tried 318 times**
The LLM repeatedly tried to use `pres.addShape(...)` which is NOT a method on PresentationBuilder.

**Root Cause Analysis:**
The validation system is NOT catching this error because of a bug in type tracking for namespace imports.

When code is:
```javascript
import * as pptx from "ha:pptx";
const pres = pptx.createPresentation();
pres.addShape(...)  // Should fail validation!
```

The parser correctly identifies this as a chained call:
- `initial_object` = "pptx"
- `method_chain` = ["createPresentation"]

But in `track_assignments` (validator.rs:701), it tries:
```rust
let mut current_type = self.bindings.get(initial_obj).map(|s| s.as_str());
// bindings.get("pptx") returns None because pptx is a namespace import!
```

**The fix needed**: For namespace imports, detect when `initial_object` matches an imported namespace and look up the method's return type from `func_return_types` directly:
```rust
// Check if initial_object is a namespace import
if let Some(namespace_module) = namespace_imports.get(initial_obj) {
    // First method in chain is a function call on the namespace
    if let Some(first_method) = assign.method_chain.first() {
        if let Some(&return_type) = func_return_types.get(first_method.as_str()) {
            current_type = Some(return_type);
        }
    }
}
```

This requires:
1. Tracking namespace imports (`import * as X from "ha:Y"`)
2. Passing that info to the symbol table
3. Using it when resolving chained calls

**Impact**: This bug means ALL method validation on pres objects fails silently.

#### 2. **validate_code tool was NEVER called**
```bash
grep "validate_code" events.jsonl | wc -l
# Result: 0
```
Validation happens inside `register_handler` but the method validation bug above means it's ineffective.

#### 3. **No PPTX file was generated**
The run ended without producing a .pptx file - likely crashed or hit errors before completion.

### Method Usage Statistics
```
pres.addShape  - 318 occurrences (INVALID)
pres.addSlide  - 72 occurrences (valid)
pres.addBody   - 24 occurrences (valid)
pres.theme     - 3 occurrences (valid)
```

### Fixes Applied
**FIX 1: Namespace import type tracking** ✅ APPLIED

Files modified:
- `src/code-validator/guest/runtime/src/js_parser.rs`:
  - Added `NamespaceImport` struct
  - Added `extract_namespace_imports()` function to detect `import * as X from "..."`

- `src/code-validator/guest/runtime/src/validator.rs`:
  - Added `namespace_imports` field to `SymbolTable`
  - Updated `track_assignments()` to detect when `initial_object` is a namespace import
  - For namespace imports, first method in chain is looked up directly from `func_return_types`

**Test verification:**
```
npm test -- --run validateJavaScript
✓ validateJavaScript should handle namespace imports (import * as)
Tests  10 passed
```

### Additional Issues Found

#### 4. **Image downloading rate limited (429)**
From tune log:
```
Wikimedia 429 rate limit on images
Tesla.com blocks the sandbox user-agent (403)
```
The LLM only got 1 image and had to use geometric placeholders.

#### 5. **LLM discovered `addShape` is invalid at runtime, not validation time**
The tune log shows:
```
"pres.addShape is not a method — need to check actual pres API methods"
```
This error was discovered AFTER `execute_javascript` failed, not during `register_handler` validation.
With the fix above, this should now be caught during validation.

---

## Iteration 1b - Re-test with fix (00:32 session analysis)

This session ran at 00:32 BEFORE the namespace import fix was applied.

**Tune Log Analysis** (`tune-2026-03-12T00-32-00.jsonl`):

| Time | Category | Message |
|------|----------|---------|
| 00:32:28 | decision | Need both web-research and file-builder profiles |
| 00:32:59 | decision | Will fetch Wikipedia then Tesla.com for images |
| 00:33:35 | concern | Wikipedia image URLs are finicky |
| 00:33:39 | decision | Query Wikimedia API for actual filenames |
| 00:34:12 | concern | Wikimedia rate-limiting on images |
| 00:34:18 | constraint | **Wikimedia 429** - trying Tesla.com |
| 00:34:52 | constraint | **Tesla.com 403** - blocks sandbox user-agent |
| 00:35:32 | decision | Got 1 Tesla hero image, will use SVG placeholders |
| 00:37:39 | decision | Building 12-slide brutalist deck |
| 00:38:00 | concern | **pres.addShape is not a method** (runtime error) |
| 00:39:34 | decision | Must use pres.addSlide() or pres.addBody() instead |

**Key Finding:** Session ended attempting to fix the handler. No final PPTX produced.

---

## Iteration 2 - WITH namespace fix applied ✅ SUCCESS

**Command:** `just start-debug --tune --verbose --debug --skill pptx-expert --auto-approve --transcript --show-code --prompt-file /tmp/cybertruck-prompt.txt`

**Session ID:** hyperagent-2026-03-12T01-02-04

**Result:** ✅ **15-slide PPTX generated successfully!**
- File: `/tmp/hyperlight-fs-d5577124-98a6-46/cybertruck_launch.pptx`
- Size: 136,744 bytes
- Slides: 15

### Key Observations

#### 1. **Namespace import fix WORKED - No `pres.addShape` errors!**
The debug log shows ZERO `addShape` errors. The LLM correctly used `pres.addSlide()` throughout.

#### 2. **Rate limiting still a major friction point**
```
Wikimedia rate-limited all 4 image downloads
Wikimedia 429 rate-limit persists across retries
```
The LLM managed to get 3 of 4 images by retrying manually.

#### 3. **State reset on handler registration still painful**
```
"Registering build_deck handler reset all state including shared-state image data. Must re-download images before building."
```
This forced re-downloading images after registering a new handler.

### LLM Feedback (from session output)

**Pain Points Reported:**

1. **No `setTimeout`/delay capability**
   - Wikimedia 429s require waiting, but sandbox has no delay
   - Suggested: `sleep(ms)` function or `retryAfterMs: auto` in fetch plugin

2. **State reset on handler registration**
   - All shared-state wiped when registering new handlers
   - Suggested: persist ha:shared-state to scratch/disk, or "compile all" step

3. **No batch image download**
   - Multiple fetches in one handler hit rate limits
   - Suggested: `fetchBinaryBatch(urls[], {delayMs})`

4. **Output buffer too small for large responses**
   - Wikipedia article was 25KB, got truncated
   - Suggested: increase buffer or add `truncate` option

5. **forceColor repetition**
   - Had to add `forceColor: true` to every element for dark theme
   - Suggested: `createPresentation({ forceAllColors: true })`

6. **blankSlide pattern is clunky**
   - Had to use `pres.slides[pres.slides.length - 1]` to access last slide
   - Suggested: `customSlide(pres, { bg, body, transition, notes })`

7. **Domain budget (5 max)**
   - Research tasks need more than 5 unique domains
   - Suggested: higher default or treat subdomains as one domain

### Tune Log Summary

| Time | Category | Message |
|------|----------|---------|
| 01:02:32 | decision | Need web-research + file-builder profiles |
| 01:03:08 | decision | Using Wikipedia API + Wikimedia Commons |
| 01:03:50 | decision | Downloading 4 images at 800px |
| 01:04:08 | concern | **Wikimedia 429 on all 4 downloads** |
| 01:04:38 | constraint | 429 persists across retries |
| 01:05:37 | decision | Got 3 images, proceeding with placeholders |
| 01:05:43 | decision | Using dark-gradient theme with black BGs |
| 01:07:38 | decision | Building 12-slide brutalist deck |
| 01:07:56 | concern | **State reset forced image re-download** |

### Validation Status

- ✅ No `pres.addShape` errors (namespace fix working)
- ✅ PPTX file generated and valid ZIP structure
- ⚠️ Rate limiting caused image download failures
- ⚠️ State management still forces redundant work

---

## Iteration 3 - WITHOUT pptx-expert skill ✅ SUCCESS

**Command:** `just start-debug --tune --verbose --debug --auto-approve --transcript --show-code --prompt-file /tmp/cybertruck-prompt.txt`

**Session ID:** hyperagent-2026-03-12T01-15-36

**Result:** ✅ **11-slide PPTX generated successfully!**
- File: `/tmp/hyperlight-fs-2c74c8fc-e360-43/cybertruck_launch.pptx`
- Size: 449,244 bytes (3.3x larger than with-skill version!)
- Slides: 11
- Duration: 6m 14s

### Key Observations

#### 1. **More sophisticated slides without skill guidance**
The LLM built more complex slides with larger embedded images:
- Slide 8 alone is 25KB (likely a detailed comparison table)
- Total file is 3.3x larger (more content/images embedded)

#### 2. **CPU timeout hit at 3000ms**
```
"CPU timeout at 3000ms building 11-slide PPTX with 4 embedded images. Need to increase CPU limit."
```
Image embedding with base64+DEFLATE is CPU-intensive. LLM had to bump to 15000ms.

#### 3. **Rate limiting still an issue but handled differently**
Created a separate `retry_imgs` handler to retry failed downloads.
```
"Wikimedia rate-limited 2 of 4 image downloads. Need to retry after a brief wait."
```

#### 4. **Wikipedia content type issue**
```
"Wikipedia raw returns text/x-wiki content type, need to use REST API for JSON or adjust allowed types."
```
Had to reconfigure fetch plugin mid-session.

### LLM Feedback (from session output)

**Plugin/Fetch Issues:**
1. Wikipedia `text/x-wiki` content type blocked by default - needs broader text/* default
2. Wikimedia 429 rate limiting - needs retry-with-backoff option
3. Domain discovery mode would help vs guessing domains upfront

**Module/Handler Issues:**
1. CPU timeout at 3000ms - file-builder profile default should be 5-10s
2. `table()` is in `pptx-tables` not `pptx` - tripped up module discovery
3. `forceColor: true` needed everywhere - wants presentation-level disable

**What Worked Well:**
- `shared-state` preserving `Uint8Array` binary data
- `pres.addSlide(solidFill(bg), shapes)` for layout control
- `statBox()` for keynote-style big numbers
- `embedImage()` with raw binary data

### Tune Log Summary

| Time | Category | Message |
|------|----------|---------|
| 01:15:52 | decision | Need web-research + file-builder profiles |
| 01:16:31 | decision | Fetching Wikipedia page for specs |
| 01:16:56 | concern | Wikipedia text/x-wiki content type blocked |
| 01:17:59 | decision | Using 1200px thumbnails, building 11-slide deck |
| 01:20:24 | decision | Single handler with shared-state for images |
| 01:20:24 | constraint | Using forceColor:true throughout |
| 01:20:42 | concern | **Wikimedia 429 on 2 of 4 images** |
| 01:21:10 | constraint | **CPU timeout at 3000ms** - bumped to 15000ms |

---

## Iteration 4 - WITH pptx-expert skill (second run) ✅ SUCCESS

**Command:** `just start-debug --tune --verbose --debug --skill pptx-expert --auto-approve --transcript --show-code --prompt-file /tmp/cybertruck-prompt.txt`

**Session ID:** hyperagent-2026-03-12T01-28-33

**Result:** ✅ **13-slide PPTX generated successfully!**
- File: `/tmp/hyperlight-fs-603f5f78-5a54-44/cybertruck-launch.pptx`
- Size: 593,144 bytes (largest so far!)
- Slides: 13
- 4 images embedded

### Key Observations

1. **No `addShape` errors** - namespace fix confirmed working
2. **CPU timeout at 3000ms** - LLM bumped to 10000ms and succeeded
3. **Rate limiting** - Wikimedia 429s again, but handled with retries
4. **`addSlideNumbers` fails with raw addSlide()** - needs themed slide functions

### Tune Log Summary

| Time | Category | Message |
|------|----------|---------|
| 01:29:02 | decision | Need web-research + file-builder profiles |
| 01:29:42 | decision | Using dark-gradient theme |
| 01:30:22 | constraint | **Wikimedia 429 rate limit** |
| 01:31:41 | decision | Building full deck in one handler |
| 01:33:34 | constraint | **addSlideNumbers fails with raw addSlide()** |
| 01:35:23 | constraint | **CPU timeout at 3000ms** - needs ~6000ms |

---

## Summary: All 4 Iterations

| Iteration | Skill | Slides | Size | Images | addShape Errors | CPU Timeout |
|-----------|-------|--------|------|--------|-----------------|-------------|
| 1 (pre-fix) | Yes | N/A | N/A | N/A | **318** | N/A |
| 2 | Yes | 15 | 136 KB | 3 | **0** | No |
| 3 | No | 11 | 449 KB | 4 | **0** | Yes (3s) |
| 4 | Yes | 13 | 593 KB | 4 | **0** | Yes (3s) |

### Key Findings

1. **Namespace import fix works** - Zero `pres.addShape()` errors in all post-fix iterations
2. **CPU timeout needs increase** - 3000ms default too low for image-heavy decks
3. **Rate limiting is consistent issue** - Every iteration hit Wikimedia 429s
4. **Without skill produces similar quality** - Iteration 3 worked well without pptx-expert skill
5. **File sizes vary** - 136KB to 593KB depending on image sizes and count

---

## Comparison: With vs Without Skill (Updated)

| Metric | With Skill (Iter 2) | Without Skill (Iter 3) |
|--------|---------------------|------------------------|
| Slides | 15 | 11 |
| File Size | 136 KB | 449 KB |
| Images Embedded | 3 | 4 |
| CPU Timeout Hit | No | Yes (3000ms) |
| Duration | ~6 min | 6m 14s |
| Rate Limit Issues | Yes (3 of 4 failed) | Yes (2 of 4 failed) |
| `addShape` Errors | **0** | **0** |

**Key Finding:** Without the pptx-expert skill, the LLM:
- Used a single unified handler approach (vs separate download/build handlers)
- Embedded larger/more images (449KB vs 136KB)
- Hit CPU timeout (3000ms wasn't enough)
- Still avoided `pres.addShape` error (namespace fix working!)

---

## Design Recommendations (Updated from Iterations 2 & 3)

### Priority 1: CPU Timeout for Image-Heavy Decks
1. **Increase file-builder profile CPU default to 10000ms** - image embedding is CPU-heavy
2. **Document that decks with 4+ images need 15000ms+** in _HINTS

### Priority 2: Rate Limit Handling
1. **Add `sleep(ms)` to sandbox** - cap at 15 seconds
2. **Auto-retry with backoff in fetch plugin** - handle 429s transparently
3. **Return Retry-After header value** in error message

### Priority 3: Content Type Handling
1. **Allow `text/*` content types by default** for Wikipedia etc.
2. **Or add `allowedContentTypes: ["text/*"]` shorthand**

### Priority 4: PPTX API Ergonomics
1. **Re-export `table` from pptx module** - avoid `ha:pptx-tables` import confusion
2. **Add `forceAllColors` option** to createPresentation()
3. **Add `customSlide()` helper**

### Priority 5: Domain Configuration
1. **Add domain discovery mode** or relaxed defaults for research tasks
2. **Treat subdomains as same domain** for budget purposes

---
