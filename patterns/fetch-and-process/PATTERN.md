---
name: fetch-and-process
description: Fetch web content and extract structured data using ha:html or ha:markdown
modules: [html, markdown, shared-state]
plugins: [fetch]
profiles: [web-research]
wallTimeoutMs: 120000
---

1. Enable fetch plugin with allowedDomains for the target sites
2. Check URL status and content type before reading the full response
3. Read the response in a loop until done — collect chunks in an array, join at end
4. For HTML: parse with ha:html to get text and links in one pass
5. For Markdown: convert to plain text using ha:markdown
6. For JSON APIs: parse the response directly with JSON.parse
7. Always check response status before reading — handle HTTP errors gracefully
8. Use ha:shared-state to pass fetched data to a build handler
