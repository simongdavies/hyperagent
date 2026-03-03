# Plugins Directory

Plugins extend the Hyperlight sandbox with host functions that guest JavaScript imports via `require("host:<module>")`.

## Rules

- **TypeScript only** — All plugins must be `.ts` files. No `.js` files allowed.
- **Enforced by** — `tests/plugin-source.test.ts` fails if `.js` files exist
- Each plugin lives in its own directory with `index.ts` and `plugin.json`

## Structure

```
plugins/
├── fs-read/index.ts      # Read-only filesystem (jailed to base directory)
├── fs-write/index.ts     # Write-only filesystem (jailed to base directory)
├── fetch/index.ts        # Secure HTTPS fetching
├── shared/               # Shared utilities (not a plugin)
│   └── path-jail.ts      # Path validation for fs plugins
└── plugin-schema-types.ts
```

## Security Model

- Plugins are security boundaries — guest code cannot escape the sandbox
- Path traversal attacks are blocked via `shared/path-jail.ts`
- Symlinks are rejected outright
- Dotfiles are always blocked
- Error messages are sanitised (no raw OS paths leak to guest)

## Adding a New Plugin

1. Create `plugins/<name>/index.ts` with plugin implementation
2. Create `plugins/<name>/plugin.json` with manifest
3. Export functions that will be available to guest JS
4. Run `just test` to verify TypeScript requirement is met
