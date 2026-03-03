---
name: report-builder
description: Generate documents, reports, and formatted output files
triggers:
  - report
  - document
  - DOCX
  - markdown
  - generate
  - summary
  - output
  - write
  - create file
patterns:
  - two-handler-pipeline
  - file-generation
antiPatterns:
  - Don't build the entire report in one monolithic handler
  - Don't inline large template strings — keep handlers under 4KB
  - Don't forget to enable fs-write plugin before writing files
---

## Report Building Guidance

For TEXT reports (Markdown, plain text, CSV, JSON):
- Use write_output(path, content) directly — no sandbox needed
- Build the content as a string in the LLM context
- write_output requires fs-write plugin to be enabled

For binary formats (DOCX, PPTX, ZIP):
- Use the sandbox with ha:zip-format or ha:pptx
- Apply file-builder profile for generous heap/scratch limits
- Write binary output via fs-write plugin from the handler

For multi-section reports:
- Build sections as strings, concatenate, then write_output
- Or use event dispatch in sandbox for complex transformations
- Use ha:shared-state if data needs to survive handler recompiles

For reading input files:
- Use read_input(path) directly — no sandbox needed
- Requires fs-read plugin to be enabled

Always apply the file-builder profile before building binary files.
