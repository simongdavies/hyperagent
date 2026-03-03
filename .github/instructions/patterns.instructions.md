---
applyTo: "patterns/**"
---

# Patterns

Reusable implementation patterns for common sandbox workflows. Skills reference patterns via their `patterns:` frontmatter.

## Pattern Structure

```
patterns/<pattern-name>/
└── PATTERN.md          # Pattern definition with frontmatter + steps
```

## PATTERN.md Format

```yaml
---
name: pattern-name
description: One-line description
modules: [module1, module2]    # ha:* modules needed
plugins: [plugin1]             # host:* plugins needed (optional)
profiles: [profile-name]       # Resource profiles to apply (optional)
config:                        # Config overrides (optional)
  heapMb: 64
  cpuTimeoutMs: 30000
---

1. First implementation step
2. Second implementation step
3. ...
```

## Current Patterns

| Pattern | Purpose |
|---------|---------|
| `two-handler-pipeline` | Research → Build using ha:shared-state |
| `fetch-and-process` | Fetch external data and process it |
| `file-generation` | Generate output files |
| `image-embed` | Embed images in output |
| `data-extraction` | Extract structured data |
| `data-transformation` | Transform data between formats |

## Adding a Pattern

1. Create `patterns/<name>/PATTERN.md`
2. Add YAML frontmatter with required modules/plugins
3. Write numbered implementation steps in the body
4. Reference from skills via `patterns: [<name>]`
