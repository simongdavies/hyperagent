---
name: data-extraction
description: Extract structured data from web pages using ha:html
modules: [html, markdown]
plugins: [fetch]
profiles: [web-research]
---

1. Fetch the target page using the fetch plugin
2. Parse HTML with ha:html to get both text and links in one pass
3. Filter links by href pattern to find relevant URLs (downloads, next pages, APIs)
4. For text-only extraction, use ha:html to convert HTML to plain text
5. For paginated content: follow next-page links and concatenate results
6. Store extracted data in ha:shared-state for use by a build handler
7. Return structured results: { title, content, links, metadata }
