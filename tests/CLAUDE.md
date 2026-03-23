# Tests Directory

Vitest test suite for Hyperagent.

## Running Tests

```bash
just test          # Run all TypeScript tests
just test-analysis-guest  # Run Rust tests (analysis-guest)
just test-all      # Run both
```

## Key Test Files

| Test | What it enforces |
|------|------------------|
| `plugin-source.test.ts` | Plugins must be TypeScript (no .js files) |
| `dts-sync.test.ts` | Generated .d.ts files match compiled output |
| `path-jail.test.ts` | Path validation security |
| `plugin-auditor.test.ts` | Plugin security auditing |
| `fs-read.test.ts` / `fs-write.test.ts` | Filesystem plugin security |

## Test Fixtures

Test fixtures live in `fixtures/` and must also be TypeScript:

- `fixtures/test-plugin/index.ts` — Basic plugin for testing
- `fixtures/dangerous-plugin/index.ts` — Plugin with security issues (for auditor tests)
- `fixtures/companion-plugin/index.ts` — Plugin dependency testing

## Adding Tests

1. Create `<feature>.test.ts` in this directory
2. Use Vitest's `describe`, `it`, `expect` API
3. Import from `vitest` not other test frameworks
