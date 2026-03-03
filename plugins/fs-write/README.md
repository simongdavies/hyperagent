# ✏️ fs-write Plugin

Write-only filesystem access for the Hyperlight sandbox. Guest JavaScript
gets writeFile, appendFile, and mkdir — all confined to a **single base
directory** with no escape.

Split from the original `fs-access` plugin to allow independent approval
of read vs write capabilities. For read operations, see the companion
[fs-read](../fs-read/) plugin.

**Version:** 1.0.0
**Host Module:** `host:fs-write`

## Quick Start

```
You: /plugin enable fs-write baseDir=/tmp/sandbox
```

Guest code:

```javascript
const fs = require("host:fs-write");

// Write a file
fs.writeFile("output.txt", "Hello from the sandbox");

// Append to a file
fs.appendFile("log.txt", "New log entry\n");

// Create a directory
fs.mkdir("data");
```

## Security Model

| Layer                  | Defence                                                                  |
| ---------------------- | ------------------------------------------------------------------------ |
| **Single base dir**    | All paths resolved relative to one directory. No second roots.           |
| **Path traversal**     | `..` segments rejected after `resolve()` normalisation. Belt AND braces. |
| **Symlink rejection**  | `lstatSync` pre-check + `O_NOFOLLOW` on open (closes TOCTOU window).     |
| **Dotfile blocking**   | Always blocked — no `.env`, `.git`, `.ssh`, etc. No config option.       |
| **File size cap**      | Write/append operations capped (configurable, cumulative for appends).   |
| **Entry creation cap** | Combined file + directory count limit prevents inode/disk exhaustion.    |
| **No delete**          | Write operations are create/overwrite/append only. No `unlink`/`rmdir`.  |
| **No reads**           | This plugin has ZERO read operations. Write-only by design.              |
| **Sanitised errors**   | No raw host paths leak to the guest. Errors describe what, not where.    |
| **Temp dir fallback**  | If no `baseDir` configured, creates unique temp dir under `os.tmpdir()`. |
| **File mode**          | Created files use mode `0600` — owner read/write only.                   |
| **No recursive mkdir** | `mkdir` creates a single level — parent must exist.                      |

## Configuration

| Field            | Type     | Default           | Required | Description                                                                        |
| ---------------- | -------- | ----------------- | -------- | ---------------------------------------------------------------------------------- |
| `baseDir`        | `string` | _(auto temp dir)_ | No       | Absolute path to the jail directory. If omitted, a unique temp dir is created.     |
| `maxWriteSizeKb` | `number` | `256`             | No       | Max per-file write/append size in KB. Cumulative for appends. Max: 10240 (10 MB).  |
| `maxEntries`     | `number` | `100`             | No       | Max files + directories that can be created. Prevents disk exhaustion. Max: 10000. |

### Inline Config Examples

```
/plugin enable fs-write baseDir=/home/user/project
/plugin enable fs-write baseDir=/tmp/sandbox maxWriteSizeKb=1024 maxEntries=500
/plugin enable fs-write                          # Uses auto-generated temp dir
```

## Functions

### `fsWrite.writeFile(path, content)`

Write string content to a file (creates or overwrites).

- **Input:** relative path, string content
- **Returns:** `{ ok: true }` on success, `{ error: string }` on failure
- **Size limit:** configurable via `maxWriteSizeKb`
- **Note:** parent directory must exist

### `fsWrite.appendFile(path, content)`

Append string content to a file (creates if missing).

- **Input:** relative path, string content
- **Returns:** `{ ok: true }` on success, `{ error: string }` on failure
- **Size limit:** cumulative (existing + new) checked against `maxWriteSizeKb`

### `fsWrite.mkdir(path)`

Create a single directory.

- **Input:** relative path string
- **Returns:** `{ ok: true }` on success, `{ error: string }` on failure
- **Note:** single level only — parent must already exist

## Error Categories

All operations return `{ error: string }` on failure. Error messages are
sanitised — no raw host paths are exposed.

| Error                                    | Meaning                                            |
| ---------------------------------------- | -------------------------------------------------- |
| `Access denied: path traversal`          | Path attempts to escape the base directory         |
| `Access denied: symlink`                 | Path contains a symlink (always rejected)          |
| `Access denied: dotfile`                 | Path contains a dotfile component (always blocked) |
| `Content too large: exceeds write limit` | Content exceeds `maxWriteSizeKb`                   |
| `Entry limit reached`                    | Combined file+dir count exceeds `maxEntries`       |
| `Parent directory does not exist`        | Write/mkdir target's parent is missing             |
| `Directory already exists`               | mkdir target already exists                        |
| `Path must be a non-empty string`        | Invalid input type                                 |

## Guest Usage Examples

```javascript
const fs = require("host:fs-write");

// Write output
const result = JSON.parse(fs.writeFile("output.txt", "Hello!"));
if (result.error) {
  console.log("Write failed:", result.error);
}

// Create a directory then write into it
fs.mkdir("data");
fs.writeFile("data/results.json", JSON.stringify({ count: 42 }));

// Append to a log
fs.appendFile("session.log", "Operation completed\n");
```

---
