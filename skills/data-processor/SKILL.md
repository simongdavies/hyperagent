---
name: data-processor
description: Transform, filter, and analyse data using sandbox handlers
triggers:
  - CSV
  - JSON
  - transform
  - convert
  - process
  - analyse
  - analyze
  - data
  - filter
  - aggregate
  - sort
  - parse
patterns:
  - data-transformation
  - two-handler-pipeline
antiPatterns:
  - Don't load entire datasets into handler source code — pass via event parameter
  - Don't process everything in one giant handler call — chunk large datasets
  - Don't use string manipulation for structured data — parse properly first
---

## Data Processing Guidance

Use the event dispatch pattern for multi-step processing:
```
register_handler('processor', `
  export function handler(event) {
    if (event.action === 'load') { /* parse and store */ }
    if (event.action === 'transform') { /* filter/map/reduce */ }
    if (event.action === 'export') { /* format output */ }
  }
`)
```

For large datasets:
- Pass data in chunks via event parameter
- Accumulate results in module-level state
- Use ha:shared-state if results need to survive recompilation

For file I/O:
- Use write_output(path, content) for text output (CSV, JSON, Markdown) — no sandbox needed
- Use read_input(path) for reading text input files — no sandbox needed
- Use fs-write plugin in sandbox only for binary output
- Enable file-builder profile for generous limits on large datasets

Available modules:
- ha:str-bytes for string↔bytes conversion
- ha:base64 for encoding/decoding
- ha:markdown for Markdown generation
