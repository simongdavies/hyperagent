---
name: image-embed
description: Fetch images from URLs and embed in output with correct aspect ratio
modules: [image, base64, shared-state]
plugins: [fetch]
profiles: [web-research]
heapMb: 64
wallTimeoutMs: 60000
---

1. Enable fetch plugin with image content types (image/png, image/jpeg, image/gif)
2. Verify image exists and check content type before downloading
3. Download image as Uint8Array using the fetch plugin
4. Read image dimensions from header using ha:image
5. Calculate aspect-ratio-correct placement: scale = min(targetW/width, targetH/height)
6. Pass raw Uint8Array bytes to the embedding function — no base64 encoding needed for PPTX
7. Store downloaded images in ha:shared-state if they'll be used across handlers
8. For multiple images: download all in the research handler, embed in the build handler
