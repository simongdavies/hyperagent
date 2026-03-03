# 📖 fs-read Plugin

> One base directory. Everything is scoped to it. Period.

Read-only filesystem access for the Hyperlight sandbox. Guest JavaScript
gets readFile, listDir, and stat — all confined to a **single base
directory** with no escape.

Split from the original `fs-access` plugin to allow independent approval
of read vs write capabilities. For write operations, see the companion
[fs-write](../fs-write/) plugin.

**Version:** 1.0.0
**Host Module:** `host:fs-read`

## Quick Start

```
You: /plugin enable fs-read baseDir=/tmp/sandbox
```

Guest code:

```javascript
const fs = require('host:fs-read');

// Read a file
const content = fs.readFile('notes.txt');

// List a directory
const entries = JSON.parse(fs.listDir('.'));

// Get file metadata
const info = JSON.parse(fs.stat('notes.txt'));
```

## Security Model

| Layer                 | Defence                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| **Single base dir**   | All paths resolved relative to one directory. No second roots.           |
| **Path traversal**    | `..` segments rejected after `resolve()` normalisation. Belt AND braces. |
| **Symlink rejection** | `lstatSync` pre-check + `O_NOFOLLOW` on open (closes TOCTOU window).     |
| **Dotfile blocking**  | Always blocked — no `.env`, `.git`, `.ssh`, etc. No config option.       |
| **File size cap**     | Read operations capped (configurable).                                   |
| **Sanitised errors**  | No raw host paths leak to the guest. Errors describe what, not where.    |
| **Temp dir fallback** | If no `baseDir` configured, creates unique temp dir under `os.tmpdir()`. |
| **No writes**         | This plugin has ZERO write operations. Read-only by design.              |

## Configuration

| Field           | Type     | Default           | Required | Description                                                                                  |
| --------------- | -------- | ----------------- | -------- | -------------------------------------------------------------------------------------------- |
| `baseDir`       | `string` | _(auto temp dir)_ | No       | Absolute path to the jail directory. If omitted, a unique temp dir is created.               |
| `maxFileSizeKb` | `number` | `512`             | No       | Max file size to read in KB. Set to 0 to block reads of non-empty files. Max: 10240 (10 MB). |

### Inline Config Examples

```
/plugin enable fs-read baseDir=/home/user/project
/plugin enable fs-read baseDir=/tmp/sandbox maxFileSizeKb=2048
/plugin enable fs-read                          # Uses auto-generated temp dir
```

## Functions

### `fsRead.readFile(path)`

Read a file as UTF-8 text.

- **Input:** relative path string
- **Returns:** `{ content: string }` on success, `{ error: string }` on failure
- **Size limit:** configurable via `maxFileSizeKb`

### `fsRead.listDir(path)`

List directory contents.

- **Input:** relative path string (use `"."` for the base directory)
- **Returns:** JSON array of `[{ name, type }]` objects (`type` is `"file"` or `"directory"`)
- **Limit:** max 1000 entries returned

### `fsRead.stat(path)`

Get file or directory metadata.

- **Input:** relative path string
- **Returns:** `{ size, isFile, isDirectory }` on success

## Error Categories

All operations return `{ error: string }` on failure. Error messages are
sanitised — no raw host paths are exposed.

| Error                                | Meaning                                    |
| ------------------------------------ | ------------------------------------------ |
| `File not found`                     | Path does not exist                        |
| `Directory not found`                | Path does not exist or is not a directory  |
| `Access denied: path traversal`      | Path attempts to escape the base directory |
| `Access denied: symlink`             | Path contains a symlink (always rejected)  |
| `Access denied: dotfile`             | Path contains a dotfile component          |
| `File too large: exceeds read limit` | File exceeds `maxFileSizeKb`               |
| `Path must be a non-empty string`    | Invalid input type                         |

## Guest Usage Examples

```javascript
const fs = require('host:fs-read');

// Read and parse JSON
const raw = fs.readFile('config.json');
const parsed = JSON.parse(raw);
if (parsed.error) {
    console.log('Read failed:', parsed.error);
} else {
    const config = JSON.parse(parsed.content);
}

// List files
const entries = JSON.parse(fs.listDir('.'));
for (const entry of entries) {
    console.log(`${entry.type}: ${entry.name}`);
}
```

---
