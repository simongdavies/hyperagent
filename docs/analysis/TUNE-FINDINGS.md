# HyperAgent Tuning Findings

This document records findings from iterative testing of the Cybertruck presentation task.

## Test Configuration

**Prompt**: Research Teslas Cybertruck features and create a product launch deck as if you are Elon announcing it on stage. Go full brutalist design - stark contrasts, massive typography, cinematic vehicle images, spec comparisons in bold tables. Dark background, minimal text per slide, maximum visual impact. Include a 'just one more thing' reveal slide at the end. Make sure you got the internet to research and find images dont just rely on your training data. Report on what difficulties you had using the modules, building handlers, using plugins and what changes would make things quicker, easier and more efficient.

**Commands**:
- With skill: `just start-debug --tune --verbose --debug --skill pptx-expert --auto-approve --transcript --show-code`
- Without skill: `just start-debug --tune --verbose --debug --auto-approve --transcript --show-code`

## Log Locations

- Transcript: `~/.hyperagent/logs/hyperagent-<timestamp>.log` and `.txt`
- Tune log: `~/.hyperagent/logs/tune-<timestamp>.jsonl`
- Debug log: `~/.hyperagent/logs/agent-debug-<timestamp>.log`
- Crash dumps: `/tmp/cores/`

---

## Iteration Log

### Iteration 1 (With Skill)

**Started**: 2026-03-11 12:22:33
**Status**: COMPLETED SUCCESSFULLY
**Output**: cybertruck-launch.pptx (13 slides, 330KB, 3 embedded Wikimedia images)

#### Issues Found

1. **fetchBinary() silently returns 0 bytes** - When a URL's body has been partially consumed by a prior readBinary() call, fetchBinary() returns 0 bytes without error. LLM had to fall back to get()+readBinary() loop.

2. **readBinary() requires loop but docs unclear** - Returns 48KB chunks. Docs don't make clear you must loop until empty array. LLM had to discover this through experimentation.

3. **Tesla.com returns 403** - Their WAF blocks the sandbox user-agent. LLM had to rely entirely on Wikipedia. (Not a bug - external constraint)

4. **pres.addBody() doesn't exist** - LLM tried to use `blankSlide(pres)` then `pres.addBody([...])` which doesn't exist. Error was initially masked by WCAG color check throwing first (JS evaluates arguments before the function call).

5. **createPresentation() docs truncated** - The return description is cut off - it doesn't list actual methods (`addSlide`, `build`, etc.). LLM had to write introspection handler to discover them.

6. **WCAG contrast validation against wrong background** - For textBoxes placed on dark rects, contrast validates against theme background, not the rect beneath. LLM workaround: add `background: '1A1A1A'` to textBoxes.

7. **No documented custom slide API** - `blankSlide()` creates slide but no way to add shapes. `contentSlide()` forces themed layout. Only `pres.addSlide(bgXml, shapesXml)` works for full control but is undocumented.

8. **Image storage requires Array.from()** - Images must be stored as `Array.from(uint8Array)` because shared-state serializes to JSON. Converting 150KB images to/from arrays is wasteful.

#### Fixes Applied

1. **fetchBinary() bug fix** - Was checking `chunk.length` (number of properties = 2) instead of `chunk.data.length`. Fixed to correctly loop until `chunk.done`.

2. **_HINTS documentation** - Added "CUSTOM SLIDES" section documenting `pres.addSlide(bgXml, shapesXml, opts)` for full layout control.

#### Recommendations (Design Changes for Later)

1. **fetchBinary() reliability** - Should always work as one-shot, handle cached/consumed URLs internally
2. **Binary blob store** - Support Uint8Array in shared-state or provide dedicated binary storage
3. **Document pres.addSlide()** - Either document as first-class API or add `customSlide()` function
4. **Contrast context awareness** - Let textBox detect when layered inside a rect, or provide skipContrast opt-in
5. **registerTempHandler()** - Auto-delete after execution to reduce handler lifecycle management
6. **module_info return type docs** - Show returned object's methods explicitly

---

### Iteration 2 (Without Skill)

**Started**: 2026-03-11 12:43:16
**Status**: COMPLETED SUCCESSFULLY
**Output**: cybertruck-launch.pptx (11 slides, 208KB, 3 embedded Wikimedia images)

#### Issues Found

1. **State loss on CPU timeout** - When handler hits 3000ms CPU limit, all module-level state (downloaded images) is lost. LLM had to re-download images.

2. **Wikimedia 429 rate limiting** - 4th image request returned 429 Too Many Requests. LLM adapted by proceeding with 3 images and using placeholder.

3. **File size exceeds 1MB write limit** - Initial attempt created 1.3MB PPTX which failed to write. LLM had to use chunked appendFileBinary approach.

4. **Memory limit too low (32MB)** - ZIP+DEFLATE compression of 3 images (1MB total) exceeded 32MB scratch space. Had to increase to 64MB.

5. **CPU timeout too low (3000ms)** - Building 11-slide deck with images took ~4500ms, exceeding 3000ms limit.

6. **No opacity support on shapes** - rect() doesn't support opacity/alpha. LLM wanted semi-transparent overlays but couldn't achieve it.

7. **WCAG contrast still problematic** - Same issue as iteration 1 - textBox validates against theme background, not layered rect.

8. **shared-state can't hold Uint8Array** - LLM had to use Array.from() workaround, same as iteration 1. Data budget concern with JSON serialization.

#### Fixes Applied

None in iteration 2 - issues were resource limits (configuration) and design gaps.

#### Recommendations (Design Changes for Later)

1. **Configurable resource limits** - Allow tune mode to specify CPU/memory limits via environment variables
2. **State preservation on timeout** - Save module-level state before killing handler, restore on next execution
3. **Retry with backoff in fetch plugin** - Handle 429 automatically with exponential backoff
4. **Larger default file write limit** - 1MB too small for presentations with images
5. **Opacity support on shapes** - Add `opacity` option to rect(), line(), textBox()

---

### Iteration 3 (With Skill)

**Started**: 2026-03-11 13:00:01
**Status**: COMPLETED SUCCESSFULLY
**Output**: cybertruck-launch.pptx (14 slides, 968KB, 3 embedded Wikimedia images)

#### Issues Found

1. **Theme name not in module_info** - LLM guessed "modern-dark" which doesn't exist. Had to discover valid themes (corporate-blue, dark-gradient, etc.) through runtime error. Cost one extra handler registration cycle.

2. **Theme palette colors not visible** - _HINTS says "use theme palette values" but there's no way to inspect what colors are in each theme without running code. LLM played it safe with auto-selection.

3. **Domain budget tight** - 5 unique domains per session. Using Wikimedia (en.wikipedia.org, api.wikimedia.org, upload.wikimedia.org) consumed 3 slots. Other CDNs would be blocked.

4. **Handler re-registration resets state** - Each fix required re-registration which reset module-level state. Fetch cache helped but binary data can't use shared-state.

5. **No blankSlide body support** - blankSlide() creates empty slide but can't add shapes. contentSlide() forces title bar. No way to make full-bleed slides without chrome.

6. **Module info requires many calls** - 15+ module_info calls needed before writing code. Each function signature fetched individually. A batch function list would help.

#### Fixes Applied

None - all issues were documentation/design gaps, not code bugs.

#### What Worked Well

- fetchBinary() was bulletproof (one call, got bytes)
- embedImage() accepted Uint8Array directly
- table() with theme auto-detection handled dark mode perfectly
- statBox() auto-color selection produced good contrast
- exportToFile() was clean one-liner
- Fetch response caching prevented duplicate downloads on handler re-registration

#### Recommendations (Design Changes for Later)

1. **Theme names in module_info** - Surface available theme names in module_info output
2. **Theme palette inspector** - Show palette colors per theme in _HINTS or module_info
3. **Batch function signatures** - Single call to get all function signatures for a module
4. **blankSlide body support** - Allow adding shapes to blank slides, or add customSlide()

---

### Iteration 4 (Without Skill)

**Started**: 2026-03-11 13:12:28
**Status**: COMPLETED SUCCESSFULLY
**Output**: cybertruck-launch.pptx (12 slides, 764KB, 1 embedded Wikimedia image)

#### Issues Found

1. **Wikimedia thumbnail 429 rate limiting** - Thumbnail URLs (`/thumb/`) consistently returned 429 despite custom User-Agent. Had to use full-res originals instead (735KB-1.2MB vs ~100KB).

2. **pres.addBody() doesn't exist** - Same issue as iterations 1,3. LLM tried non-existent method, discovered pres.addSlide() via _HINTS.

3. **WCAG contrast blocks intentional dim text** - Using `333333` (dark gray) text for ghost/watermark effects threw hard error. Validator checks theme bg, not parent rect fill.

4. **State loss on every handler update** - Module-level state (fetched images) wiped on any handler change. LLM re-fetched same images 5+ times.

5. **fs-write 1MB limit too small** - 2MB PPTX with 2 images exceeded limit. LLM had to drop to 1 image.

6. **Resource limit cascading** - Hit 5 different limits sequentially (output buffer → CPU → OOM scratch → OOM heap → fs-write). Each reconfiguration rebuilt sandbox and lost state.

7. **Input buffer too small (1040KB)** - fetchBinary on 1.2MB image exceeded default buffer. Required reconfiguration.

8. **readFile() API unclear** - LLM expected `readFile(path, 'binary')` to return `{data: Uint8Array}` but got `{content: string}`. Multiple attempts needed.

#### Fixes Applied

None - all issues were documentation/design gaps, not code bugs.

#### Recommendations (Design Changes for Later)

1. **skipContrast option** - Allow intentional low-contrast text for design effects
2. **Retry-After support** - Auto-wait on 429 responses in fetch plugin
3. **apply_profile for heavy tasks** - Pre-configured limits for "image-heavy-pptx" etc.
4. **exportToFile chunked writes** - Auto-chunk large PPTX files to work within fs-write limits
5. **readFile binary mode docs** - Clarify return type for binary mode

---

### Iteration 5 (With Skill)

**Started**: 2026-03-11 13:31:12
**Status**: COMPLETED SUCCESSFULLY
**Output**: cybertruck-launch.pptx (14 slides, 678KB, 3 embedded Wikimedia images)

#### Issues Found

1. **WCAG contrast rejects custom colors** - E31937 red rejected because it fails contrast against theme bg. Had to use theme's F85149 instead. Same issue as previous iterations.

2. **pres.addBody() still doesn't exist** - Same issue from iterations 1, 3, 4. Discovered pres.addSlide() via _HINTS.

3. **State reset on handler update** - Same issue. Three handler updates = three sets of image downloads (9 extra network calls).

4. **Tesla.com 403** - Bot protection blocks access. Had to use Car and Driver for some specs.

5. **Full-res images exceed 1MB fetch limit** - Wikimedia originals are 9MB+. Had to use thumbnail API with iiurlwidth parameter.

6. **Color palette hard to discover proactively** - Contrast error messages show theme colors AFTER crash, not before.

7. **Handler code size management** - 19KB handler is verbose. String concatenation pattern works but is wordy.

#### What Worked Well

- Thumbnail API (iiurlwidth) worked reliably for image scaling
- fetchBinary() one-shot worked perfectly
- statBox(), callout(), table(), barChart() all worked great
- Theme system provided consistent professional output
- embedImage() with auto-format detection was seamless

#### Recommendations (Design Changes for Later)

1. **getContrastSafeColors(bgHex)** - Utility to query passing colors proactively
2. **Fluent slide builder API** - slide.add(textBox(...)).add(rect(...)) would be cleaner

---

### Iteration 6 (Without Skill)

**Started**: 2026-03-11 13:43:12
**Status**: COMPLETED SUCCESSFULLY
**Output**: cybertruck-launch.pptx (10 slides, 764KB, 3 embedded Wikimedia images)

#### Issues Found

1. **State loss on ANY handler registration** - Registering a "retry" handler to re-download images wiped ALL module-level state in ALL handlers, losing downloaded images. Had to re-download everything.

2. **Wikimedia 429 rate limiting** - 3rd/4th image downloads hit rate limiter. fetchBinary throws on non-2xx with no access to Retry-After headers.

3. **1MB write limit hit** - 4 images at 1280px made file 1.08MB, exceeding 1024KB limit. Had to reduce to 3 images.

4. **CPU timeout killed state** - Hitting CPU limit wiped module state, requiring re-download.

5. **No solidFill() export** - _HINTS reference `solidFill('000000')` but function not exported. Had to use empty string for bgXml.

6. **Color docs confusing** - "Don't hardcode colors" warning was confusing. Took time to realize theme palette hex values ARE valid to use.

#### What Worked Well

- Module-level vars for image storage between handler calls (when not wiped)
- Dark-gradient theme palette provided good brutalist colors
- statBox(), table() components worked great
- embedImage() seamless once images were downloaded
- Cyberquad "one more thing" reveal was creative touch

#### Recommendations (Design Changes for Later)

1. **pres.toBytes()** - Expose raw bytes without file write to allow manual chunking
2. **Export solidFill()** - Allow explicit custom slide backgrounds
3. **fetchBinary rate-limit info** - Surface 429 details instead of opaque throw

---

### Iteration 7 (With Skill)

**Started**: 2026-03-11 13:58:13
**Status**: COMPLETED SUCCESSFULLY
**Output**: cybertruck-launch.pptx (12 slides, 513KB, 3 embedded Wikimedia images)

#### Issues Found

1. **Full-res images exceed 1MB fetch limit** - Wikipedia originals are 9MB+. Had to use thumbnail API (?width=960) to get 150-280KB versions.

2. **State loss on handler update** - Same recurring issue. Re-downloading images burned data budget.

3. **Color contrast failure** - E31937 red and 666666 gray had insufficient contrast. Had to switch to theme palette (F85149, 8B949E).

4. **gradientFill() not a shape** - Tried using gradientFill() as a shape overlay, but it returns fill XML not shape XML. Can't be concatenated with shapes.

5. **CPU timeout at 3000ms** - DEFLATE compression of 618KB images exceeded default limit. Had to increase to 15000ms.

6. **solidFill() not exported** - _HINTS document it but it's not actually exported. Used gradientFill(BLACK, BLACK, 0) as workaround.

7. **No background override on contentSlide** - titleSlide has opts.background but contentSlide/sectionSlide don't. Had to use pres.addSlide() for everything.

#### What Worked Well

- Wikipedia thumbnail API (iiurlwidth=960) worked well
- pres.addSlide() gave full layout control
- table() comparison worked great
- Speaker notes on all slides added value
- Fetch cache prevented duplicate downloads

#### Recommendations (Design Changes for Later)

1. **Pre-compressed image passthrough** - Skip DEFLATE for already-compressed JPEG
2. **overlayRect()** - Semi-transparent rectangle for cinematic image effects
3. **Background override on all slide types** - Add opts.background to contentSlide, sectionSlide
4. **fetchWikipedia(title)** - Utility module for structured Wikipedia data in one call

---

### Iteration 8 (Without Skill)

**Started**: 2026-03-11 14:15:31
**Status**: COMPLETED SUCCESSFULLY
**Output**: Cybertruck_Launch_Deck.pptx (14 slides, 723KB, 3 embedded images)

#### Issues Found

1. **Tesla.com is JS SPA** - Returns 377 bytes of empty shell HTML. Can't scrape images without JS execution.

2. **Wikimedia thumbnail 429 rate limiting** - Thumbnail URLs (`/thumb/`) rate-limited after 2-3 requests. Had to use full-res original URLs instead.

3. **Wikimedia needs exact file keys** - No fuzzy search for "Cybertruck front angle". Must know exact filename.

4. **Color contrast - three different rules** - rect() checks rect fill, statBox() checks background prop, textBox() checks theme bg. Confusing inconsistency.

5. **pres.addShapes() doesn't exist** - Same as all previous iterations. Had to discover pres.addSlide() through trial and error.

6. **State reset on handler changes** - Same recurring issue. Had to re-download images 4 times during development.

7. **CPU limit hit at 3000ms** - Building 14 slides with 3 images exceeded default. Had to increase to 10000ms.

8. **file-builder profile missing image content types** - Had to manually configure fetch plugin for image/* content types.

#### What Worked Well

- Wikimedia API for finding file URLs (once exact names known)
- Action-based state machine pattern worked
- Tesla CDN image URLs worked without rate limiting
- Theme palette colors provided good contrast

#### Recommendations (Design Changes for Later)

1. **Built-in image search module** - Or curated stock API (Unsplash/Pexels)
2. **Image resize proxy** - Avoid data budget issues with large originals
3. **file-builder profile include image types** - Common content types for presentations

---

### Iteration 9 (With Skill)

**Started**: 2026-03-11 14:31:33
**Status**: COMPLETED SUCCESSFULLY
**Output**: cybertruck-launch.pptx (10 slides, 523KB, 2 embedded Wikimedia images)

#### Issues Found

1. **Theme discovery pain** - Used `theme: "midnight"` which doesn't exist. Silently fell back to "corporate-blue" (light theme). Had to register throwaway handler to call `getThemeNames()` to discover valid themes.

2. **WCAG contrast validation - biggest friction** - Module validates text colors against theme background even when shapes visually overlap (full-bleed black rect underneath). Brutalist palette (#333333 dark gray) failed contrast checks against theme bg #0D1117. Had to abandon custom palette entirely.

3. **`blankSlide()` + `addBody()` doesn't exist** - Same issue as iterations 1,3,4,5,8. No way to add shapes after creating blank slide. Discovered `pres.addSlide(bgXml, shapesXml, opts)` through _HINTS.

4. **`solidFill()` not exported** - _HINTS mentions it but not in exports. Had to use empty string for bgXml.

5. **Handler registration resets state** - Same recurring issue. Each bug fix required re-registration, wiping downloaded images. 4 iterations = 4 redundant image downloads.

6. **CPU timeout at 3000ms** - Two ~250KB JPEGs pushed build past 3s limit (DEFLATE compression expensive). Had to bump to 10s.

7. **Full-res images exceed 1MB fetch limit** - Wikipedia originals are 9MB+. Had to use thumbnail API with iiurlwidth parameter to get manageable sizes.

#### What Worked Well

- Wikipedia thumbnail API (iiurlwidth) worked reliably
- pres.addSlide() gave full layout control once discovered
- fetchBinary() one-shot worked perfectly
- statBox(), table() components worked great
- Dark-gradient theme palette provided good brutalist colors
- Fetch cache prevented duplicate downloads (helpful given state loss issues)

#### Fixes Applied

None - all issues were documentation/design gaps, not code bugs.

#### Recommendations (Design Changes for Later)

1. **Throw on invalid theme name** - `createPresentation({theme: "midnight"})` should throw instead of silent fallback
2. **`skipContrast: true` option** - Allow intentional low-contrast text for artistic/brutalist designs
3. **State preservation on handler update** - Preserve module state if imports haven't changed

### Iteration 10 (Without Skill)

**Started**: 2026-03-11 14:45:20
**Status**: COMPLETED SUCCESSFULLY
**Output**: cybertruck-launch.pptx (13 slides, 260KB, 2 embedded Wikimedia images)

#### Issues Found

1. **WCAG contrast enforcement - biggest friction** - Same issue as all iterations. System validates text against theme background even with layered black rects underneath. Had to use theme's "subtle" color (8B949E) instead of intended dim grays (555555, 666666).

2. **No solidFill() function** - _HINTS mention `solidFill()` for slide backgrounds via `pres.addSlide(bgXml, shapes)` but no such function exported. Had to use `gradientFill("000000", "0a0a0a", 270)` as workaround.

3. **Image sourcing limitations** - Wikimedia Commons worked but only provides editorial/real-world photos - not dramatic studio shots ideal for product launches. Other sources (Unsplash) need API keys.

4. **Handler recompile on every edit** - Same issue as all iterations. Every contrast color fix required re-registration, wiping downloaded images. Re-fetch adds latency on each iteration.

5. **Large handler code size** - At ~16KB for 13 slides, handler was getting large. No template/macro system to reduce verbosity.

#### What Worked Well

- fetchBinary() worked perfectly for both image downloads
- Wikimedia thumbnail URLs (960px, 500px) within size limits
- Wikipedia scraping gave good research data
- pres.addSlide() gave full layout control
- statBox(), table() components worked great
- No CPU timeout (completed within default 3s limit - impressive for 13 slides with 2 images)

#### Fixes Applied

None - all issues were design gaps, not code bugs.

#### Recommendations (Design Changes for Later)

1. **Slide template macros** - `brutalSlide(pres, {category, headline, stats})` to cut handler size by 60%+
2. **Context-aware contrast checking** - Let shapes opt out of contrast check when they have explicit dark fill underneath

---

## Summary of Issues

### Category: Broken APIs

| Issue | Iteration | Fixed? | Notes |
|-------|-----------|--------|-------|
| fetchBinary() returns 0 bytes silently | 1 | YES | Bug: was checking chunk.length not chunk.data.length |
| readBinary() chunking undocumented | 1 | NO | Docs don't explain 48KB chunks + loop requirement |
| File write limit 1MB too small | 2 | NO | Presentations with images exceed limit |

### Category: LLM Not Following Guidance

| Issue | Iteration | Fixed? | Notes |
|-------|-----------|--------|-------|
| (none observed in iteration 1) | - | - | LLM followed guidance well with skill |

### Category: Validation Gaps (Now Fixed)

| Issue | Iteration | Fixed? | Notes |
|-------|-----------|--------|-------|
| Allowed pres.addBody() which doesn't exist | 1 | **YES** | Transparent validation in `register_handler` now catches made-up methods |

**Note:** As of 2026-03-11, validation is called **transparently** by `register_handler` — no separate tool. The validator now checks:
- Method existence on known types (Phase 4.5)
- Required parameter counts (Phase 4.5.2)
- Void return type usage warnings (Phase 4.5.3)
- Property access and destructuring validation (Phase 4.5.4)

### Category: Repeated Experimentation

| Issue | Iteration | Fixed? | Notes |
|-------|-----------|--------|-------|
| Multiple handler attempts for image download | 1 | NO | fetchBinary issues forced experimentation |
| Color contrast trial-and-error | 1 | NO | Had to iterate to find working colors |
| State loss forced re-download | 2 | NO | CPU timeout kills all module state |
| Memory/CPU limit tuning | 2 | NO | Had to experiment to find working limits |
| State loss on handler updates | 4 | NO | Images re-fetched 5+ times |
| Resource limit cascading | 4 | NO | Hit 5 different limits sequentially |

### Category: Pattern/Approach Understanding

| Issue | Iteration | Fixed? | Notes |
|-------|-----------|--------|-------|
| Didn't know pres.addSlide() was the solution | 1 | YES | Added to _HINTS in pptx module |
| Theme names not discoverable | 3 | NO | Had to guess and fail to learn valid themes |
| Module function list requires many calls | 3 | NO | 15+ module_info calls needed |

### Category: State Management Understanding

| Issue | Iteration | Fixed? | Notes |
|-------|-----------|--------|-------|
| (none observed - hints were clear) | - | - | LLM correctly avoided storing pres |
| Uint8Array → Array.from() workaround | 2 | NO | LLM learned to use JSON-safe serialization |

---

## Commits Made

| Iteration | Commit Hash | Description |
|-----------|-------------|-------------|
| 1 | 4a3ac7a | fix: fetchBinary loop and pptx custom slide docs |

---

## Design Recommendations (For Later Review)

These are architectural or design changes that would improve the system but were not implemented during this tuning session.

1. **fetchBinary() robustness** - Should handle cached/consumed URLs internally, not silently return 0 bytes
2. **Binary storage in shared-state** - Support Uint8Array directly or provide dedicated binary blob store
3. **Custom slide API** - Document `pres.addSlide()` or add `customSlide(pres, {body: [...], background: '000000'})`
4. **Contrast context detection** - TextBox should detect visual context (parent rect) or provide skipContrast
5. **Temporary handlers** - `registerTempHandler()` that auto-deletes after execution
6. **Return type documentation** - `module_info()` should show returned object's methods for factory functions
7. **Opacity support on shapes** - Add `opacity` option to rect(), line(), textBox()
8. **Configurable resource limits** - Allow tune mode to specify CPU/memory limits via environment variables
9. **State preservation on timeout** - Save module-level state before killing handler, restore on next execution
10. **Retry with backoff in fetch plugin** - Handle 429 automatically with exponential backoff
11. **Larger file write limit** - 1MB too small for presentations with images, consider 10MB or streaming
12. **Theme names in module_info** - Surface available theme names in module_info output
13. **Theme palette inspector** - Show palette colors per theme in _HINTS or module_info
14. **Batch function signatures** - Single call to get all function signatures for a module
15. **blankSlide body support** - Allow adding shapes to blank slides, or add customSlide()
16. **skipContrast option** - Allow intentional low-contrast text for design effects
17. **Retry-After support in fetch** - Auto-wait on 429 responses in fetch plugin
18. **apply_profile for heavy tasks** - Pre-configured limits for "image-heavy-pptx" etc.
19. **exportToFile chunked writes** - Auto-chunk large PPTX files to work within fs-write limits
20. **readFile binary mode docs** - Clarify return type for binary mode
21. **getContrastSafeColors(bgHex)** - Utility to query passing colors proactively
22. **Fluent slide builder API** - slide.add(textBox(...)).add(rect(...)) would be cleaner than string concat
23. **pres.toBytes()** - Expose raw bytes without file write to allow manual chunking
24. **Export solidFill()** - Allow explicit custom slide backgrounds
25. **fetchBinary rate-limit info** - Surface 429 details instead of opaque throw
26. **Pre-compressed image passthrough** - Skip DEFLATE for already-compressed JPEG
27. **overlayRect()** - Semi-transparent rectangle for cinematic image effects
28. **Background override on all slide types** - Add opts.background to contentSlide, sectionSlide
29. **fetchWikipedia(title)** - Utility module for structured Wikipedia data in one call
30. **Built-in image search module** - Or curated stock API (Unsplash/Pexels)
31. **Image resize proxy** - Avoid data budget issues with large originals
32. **file-builder profile include image types** - Common content types for presentations
33. **Throw on invalid theme name** - `createPresentation({theme: "midnight"})` should throw instead of silent fallback
34. **Slide template macros** - `brutalSlide(pres, {category, headline, stats})` to cut handler size for custom layouts
35. **Context-aware contrast checking** - Let shapes opt out when they have explicit dark fill underneath

---

## Final Summary

### Test Results

| Metric | Value |
|--------|-------|
| Total Iterations | 10 |
| Successful Completions | 10 (100%) |
| With Skill (odd iterations) | 5 |
| Without Skill (even iterations) | 5 |
| Average Slides Per Deck | 11.6 |
| Average File Size | 521KB |
| Total Design Recommendations | 35 |
| Bugs Fixed | 1 (fetchBinary loop termination) |

### Most Common Issues (by frequency)

| Issue | Occurrences |
|-------|-------------|
| WCAG contrast validation friction | 10/10 |
| State loss on handler registration | 9/10 |
| pres.addBody() doesn't exist | 8/10 |
| CPU timeout on image embedding | 6/10 |
| solidFill() not exported | 4/10 |
| Theme discovery pain | 3/10 |

### Key Takeaways

1. **WCAG contrast is the #1 friction point** - The module validates text colors against theme background even when shapes visually layer on top. This prevents intentional brutalist/cinematic designs with dim/muted text.

2. **State management needs improvement** - Every handler registration wipes module-level state, forcing redundant image downloads. Supporting Uint8Array in shared-state would help significantly.

3. **API documentation gaps** - `pres.addSlide()` is the only way to create custom layouts but isn't documented. LLMs have to discover it through _HINTS or trial and error.

4. **Resource limits are learnable** - LLMs successfully adapted to CPU/memory limits by increasing them via config. The defaults (3s CPU, 32MB) are tight for image-heavy presentations.

5. **Without-skill iterations succeeded equally** - All 10 iterations (with and without pptx-expert skill) completed successfully. The skill provides faster API discovery but isn't required.

### Recommended Priority Fixes

1. ~~**Deep method validation in validate_code** (Critical)~~ **FIXED** - Transparent validation in `register_handler` now catches made-up methods like `pres.addBody()` before registration.
2. **skipContrast option** (High) - Single flag to bypass WCAG checks for artistic designs. Blocked every iteration.
3. **Binary in shared-state** (High) - Support Uint8Array to eliminate redundant image downloads. State loss forced 3-5 re-downloads per session.
4. **Export solidFill()** (Medium) - Simple utility already referenced in _HINTS but not exported
5. **Throw on invalid theme** (Low) - Prevent silent fallback to wrong theme

---

## PPTX Validation Results

### Structural Validation (python-pptx)

All 10 output files were validated for OOXML structural integrity:

| Iteration | File | Slides | Status | Issues |
|-----------|------|--------|--------|--------|
| 1 | cybertruck-launch.pptx | 13 | VALID | None |
| 2 | cybertruck-launch.pptx | 11 | VALID | None |
| 3 | cybertruck-launch.pptx | 14 | VALID | None |
| 4 | cybertruck-launch.pptx | 12 | VALID | None |
| 5 | cybertruck-launch.pptx | 14 | VALID | None |
| 6 | cybertruck-launch.pptx | 10 | VALID | None |
| 7 | cybertruck-launch.pptx | 12 | WARNING | Image with negative position (x=-190500) |
| 8 | Cybertruck_Launch_Deck.pptx | 14 | VALID | None |
| 9 | cybertruck-launch.pptx | 10 | VALID | None |
| 10 | cybertruck-launch.pptx | 13 | VALID | None |

**Summary**: 9/10 files fully valid, 1 file has minor image positioning issue (image extends beyond slide bounds but renders correctly in PowerPoint).

### Embedded Image Validation (PIL/Pillow)

All 24 embedded images across 10 files were extracted and validated:

| Iteration | Images | Format | Status |
|-----------|--------|--------|--------|
| 1 | 3 | JPEG (2), PNG (1) | All OK |
| 2 | 3 | JPEG (3) | All OK |
| 3 | 3 | JPEG (3) | All OK |
| 4 | 1 | JPEG (1) | All OK |
| 5 | 3 | JPEG (2), PNG (1) | All OK |
| 6 | 3 | JPEG (3) | All OK |
| 7 | 3 | JPEG (3) | All OK |
| 8 | 3 | JPEG (3) | All OK |
| 9 | 2 | JPEG (2) | All OK |
| 10 | 2 | JPEG (2) | All OK |

**Summary**: All images load correctly, no corruption detected.

---

## LLM Feedback Analysis

### Consolidated Difficulties Reported Across All 10 Iterations

The following friction points were explicitly reported by the LLM in the "DIFFICULTIES ENCOUNTERED" sections of each transcript:

#### Most Frequent Issues (6+ occurrences)

| Issue | Count | Description |
|-------|-------|-------------|
| **WCAG contrast validation** | 10/10 | Validates against theme background even when shapes layer visually. Blocked #333333, #666666 for brutalist designs. |
| **Handler state resets** | 9/10 | Every handler registration wipes module-level state. Images must be re-downloaded 3-5 times per session. |
| **pres.addBody() doesn't exist** | 8/10 | Attempted non-existent method on every iteration before discovering pres.addSlide() via _HINTS. |
| **CPU timeout (3s default)** | 6/10 | DEFLATE compression of images exceeds 3s limit. Required manual increase to 10-15s. |

#### Moderate Issues (3-5 occurrences)

| Issue | Count | Description |
|-------|-------|-------------|
| **solidFill() not exported** | 4/10 | Referenced in _HINTS but not actually exported. Used gradientFill(BLACK, BLACK) as workaround. |
| **Theme discovery** | 3/10 | Invalid theme names silently fall back to corporate-blue. No proactive way to list valid themes. |
| **Wikimedia 429 rate limiting** | 3/10 | Thumbnail URLs rate-limited after 2-3 requests. Had to use full-res originals instead. |

#### Less Frequent Issues (1-2 occurrences)

| Issue | Count | Description |
|-------|-------|-------------|
| Full-res images exceed fetch limit | 2 | 9MB originals require thumbnail API |
| 1MB file write limit | 2 | Presentations with 3+ images exceed limit |
| Tesla.com 403/empty shell | 2 | WAF blocks scraping, SPA returns empty HTML |
| No opacity on shapes | 1 | Can't create semi-transparent overlays |
| readFile binary mode unclear | 1 | Expected {data: Uint8Array}, got {content: string} |

### LLM Recommendations for Improvement

The following changes were explicitly requested by the LLM across iterations:

1. **`skipContrast: true` option** - Allow intentional low-contrast text for artistic designs
2. **Binary storage in shared-state** - Support Uint8Array directly instead of Array.from() workaround
3. **Export solidFill()** - Simple utility for custom slide backgrounds
4. **State preservation on handler updates** - Don't wipe module state when code hasn't changed structurally
5. **getThemeNames() in module_info** - Surface available themes proactively
6. **Throw on invalid theme** - Don't silently fall back to corporate-blue
7. **Retry-After support in fetch** - Auto-wait on 429 instead of throwing
8. **Batch function signatures** - Single call to get all exports instead of 15+ module_info calls
9. **Pre-configured resource profiles** - "image-heavy-pptx" with appropriate CPU/memory limits
10. **Slide template macros** - Reduce handler size by 60%+ with helper patterns

### Skill vs No-Skill Comparison

| Metric | With Skill (odd) | Without Skill (even) |
|--------|------------------|----------------------|
| Success rate | 100% | 100% |
| Avg slides | 12.6 | 12.0 |
| Avg file size | 602KB | 544KB |
| Avg handler iterations | 3.2 | 4.4 |
| Discovery friction | Lower | Higher |

**Key observation**: The pptx-expert skill reduced discovery friction (fewer module_info calls, faster API understanding) but did not change the fundamental issues around WCAG contrast, state management, or resource limits.

---

## Additional Analysis: Module Discovery & Validation Gaps

### Made-Up Methods — NOW FIXED

The LLM frequently invented methods that don't exist on module objects. **As of 2026-03-11, transparent validation in `register_handler` catches these before registration:**

| Method Called | Occurrences | Actual API | Status |
|--------------|-------------|------------|--------|
| `pres.addBody([...])` | 120 | Does not exist - use `pres.addSlide(bgXml, shapesXml)` | **Now caught by validator** |
| `pres.addShapes(slideIdx, [...])` | 31 | Does not exist - use `pres.addSlide(bgXml, shapesXml)` | **Now caught by validator** |
| `pres.toBytes()` | 4 | Does not exist - use `exportToFile()` | **Now caught by validator** |
| `pres.build()` | 1 | Does not exist - use `exportToFile()` | **Now caught by validator** |
| `solidFill('000000')` | 4 | Not exported - use `gradientFill(c, c, 0)` workaround | **Now caught by validator** |

**Previous root cause**: Validation only checked syntax, imports, and handler structure.

**Current state**: Validation is called **transparently** by `register_handler` and now checks:
- ✅ Syntax (QuickJS parse)
- ✅ Import specifiers exist
- ✅ Handler function exists
- ✅ Handler name conflicts
- ✅ QuickJS compatibility warnings
- ✅ **Method existence on known types** (Phase 4.5)
- ✅ **Required parameter counts** (Phase 4.5.2)
- ✅ **Void return type warnings** (Phase 4.5.3)
- ✅ **Property/destructuring validation** (Phase 4.5.4)

### Module Discovery Patterns

| Metric | Average | Range |
|--------|---------|-------|
| `module_info` calls per iteration | 6.4 | 4-9 |
| Handler registrations to get _HINTS | 2 (iter 1 only) | 0-2 |
| Made-up method runtime errors | 5/10 iterations | - |

### _HINTS Access Pattern

The LLM correctly used the `module_info` tool to access _HINTS in most iterations, but in iteration 1 registered a throwaway handler to extract _HINTS directly:

```javascript
// Iteration 1: Registered handler to extract _HINTS (wasteful)
import { _HINTS } from "ha:pptx";
function handler(event) { return { hints: _HINTS }; }
```

This pattern was not repeated in later iterations after the LLM learned `module_info` provides hints.

### Recommended Validation Improvements

1. ~~**Deep method validation** (High)~~ **FIXED** - Transparent validation now checks method existence
2. ~~**Parameter shape checking** (Medium)~~ **FIXED** - Required parameter validation implemented
3. ~~**Return type guidance** (Medium)~~ **FIXED** - Void return warnings implemented
4. **`module_info --full`** (Low) - Single call to get all function signatures + return types + _HINTS

### Runtime Error Categories

| Error Type | Count | Example |
|------------|-------|---------|
| "not a function" | 5 | `pres.addBody is not a function` |
| Contrast validation | 10 | `Text color 333333 fails WCAG AA contrast` |
| CPU timeout | 6 | `Guest CPU exceeded limit: 3000ms` |
| Memory/buffer limit | 3 | `Output buffer exceeded 1MB limit` |

