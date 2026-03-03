# Patterns

Patterns are code generation templates that guide how the LLM structures handler code. They capture proven approaches for common tasks.

## What Are Patterns?

Patterns are short markdown files that describe:
- When to use a specific approach
- What modules/profiles are needed
- Step-by-step structure

Unlike skills (which provide domain knowledge), patterns focus on code architecture.

## Built-in Patterns

| Pattern | Description |
|---------|-------------|
| `two-handler-pipeline` | Research → Build using shared-state |
| `file-generation` | Creating binary files (ZIP, PPTX, etc.) |
| `fetch-and-process` | Fetch data then transform it |
| `data-transformation` | Transform input data structures |
| `data-extraction` | Extract specific data from sources |
| `image-embed` | Embed images in generated files |

## Pattern File Format

Patterns live in `patterns/<name>/PATTERN.md`:

```yaml
---
name: two-handler-pipeline
description: Research data then build output using separate handlers
modules: [shared-state]
profiles: []
---

1. Register a RESEARCH handler that collects data
2. Store results in ha:shared-state
3. Register a BUILD handler that reads shared-state
4. Execute research → build in sequence
5. Use ha:shared-state for cross-handler data
```

### Frontmatter Fields

| Field | Description |
|-------|-------------|
| `name` | Pattern identifier |
| `description` | One-line summary |
| `modules` | Required modules |
| `profiles` | Suggested profiles |

### Body Content

Numbered steps describing the pattern structure. Keep it concise — these are injected into prompts.

## How Patterns Are Used

### Referenced by Skills

Skills can reference patterns in their frontmatter:

```yaml
---
name: pptx-expert
patterns:
  - two-handler-pipeline
  - file-generation
  - image-embed
---
```

When the skill is loaded, referenced patterns are included in the system message.

### Pattern Loading

Patterns are loaded by `src/agent/pattern-loader.ts`:
- Discovers patterns in `patterns/` directory
- Parses YAML frontmatter
- Provides pattern content to system message builder

## Common Patterns Explained

### two-handler-pipeline

For tasks that need to gather data before building output:

```
┌──────────────────┐     ┌──────────────────┐
│  RESEARCH        │     │  BUILD           │
│  handler         │────▶│  handler         │
│                  │     │                  │
│  Collects data   │     │  Creates output  │
│  Stores in       │     │  Reads from      │
│  shared-state    │     │  shared-state    │
└──────────────────┘     └──────────────────┘
```

Why two handlers?
- Keeps each handler small and focused, pushes the LLM to structure code in a modular way
- Separates concerns
- Shared-state persists across recompiles

### file-generation

For creating binary files:

1. Import required modules (zip-format, pptx, etc.)
2. Build file structure in memory
3. Return as Uint8Array or base64
4. Host writes to filesystem (if fs-write enabled)

### fetch-and-process

For web data tasks:

1. Validate URLs (require fetch plugin)
2. Fetch data with error handling
3. Parse response (JSON, HTML, etc.)
4. Transform into desired format
5. Store or return results

## Creating Custom Patterns

### 1. Create Directory

```bash
mkdir -p patterns/my-pattern
```

### 2. Create PATTERN.md

```markdown
---
name: my-pattern
description: Brief description of when to use this
modules: [required-module]
profiles: [suggested-profile]
---

1. First step
2. Second step
3. Third step
```

### 3. Reference in Skills

Add to skill frontmatter:
```yaml
patterns:
  - my-pattern
```

## Pattern vs Skill

| Aspect | Pattern | Skill |
|--------|---------|-------|
| Focus | Code structure | Domain knowledge |
| Content | Step-by-step instructions | Guidance and context |
| Size | Brief (10-20 lines) | Detailed (100+ lines) |
| Usage | Referenced by skills | Loaded directly |

Patterns and skills work together:
- Skills provide domain expertise
- Skills reference patterns for code structure
- Both are injected into system message

## See Also

- [SKILLS.md](SKILLS.md) - Domain expertise
- [MODULES.md](MODULES.md) - Available modules
- [HOW-IT-WORKS.md](HOW-IT-WORKS.md) - System overview
