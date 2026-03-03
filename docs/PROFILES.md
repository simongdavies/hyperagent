# Resource Profiles

Profiles bundle resource limits and plugin requirements into named presets. They simplify configuration for common use cases.

## Using Profiles

### Via CLI

```bash
# Single profile
hyperagent --profile file-builder

# Multiple profiles (stacked)
hyperagent --profile "web-research heavy-compute"

# With skill
hyperagent --profile file-builder --skill pptx-expert
```

### Via Slash Command

```
You: /profile file-builder
  📦 Applied profile: file-builder
     Heap: 64MB, CPU: 3000ms, Wall: 10s
     Plugins: fs-write
```

### Via Tool

The LLM can apply profiles:

```
LLM calls apply_profile({ name: "web-research" })
```

## Built-in Profiles

| Profile | Heap | CPU | Wall | Plugins | Use Case |
|---------|------|-----|------|---------|----------|
| `default` | 16MB | 1000ms | 5s | — | Math, algorithms, data transforms |
| `file-builder` | 64MB | 3000ms | 10s | fs-write | ZIP, PPTX, CSV, image generation |
| `web-research` | 32MB | 2000ms | 30s | fetch, fs-write | API calls, web scraping, pipelines |
| `heavy-compute` | 64MB | 10000ms | 15s | — | Large datasets, crypto, simulations |

## Profile Stacking

When multiple profiles are applied, settings are combined:

- **Resource limits**: Maximum of each limit
- **Plugins**: Union of all plugins

### Example

```bash
hyperagent --profile "web-research heavy-compute"
```

Results in:
- Heap: 64MB (max of 32MB and 64MB)
- CPU: 10000ms (max of 2000ms and 10000ms)
- Wall: 30s (max of 30s and 15s)
- Plugins: fetch, fs-write

## Resource Limits

### CPU Timeout

Maximum CPU time per handler execution:
- `default`: 1000ms (1 second)
- `heavy-compute`: 10000ms (10 seconds)

Override: `--cpu-timeout <ms>` or `/timeout cpu <ms>`

### Wall Timeout

Maximum wall-clock time per execution:
- `default`: 5000ms (5 seconds)
- `web-research`: 30000ms (30 seconds)

Override: `--wall-timeout <ms>` or `/timeout wall <ms>`

### Heap Size

Maximum JavaScript heap:
- `default`: 16MB
- `file-builder`: 64MB

Override: `--heap-size <MB>`

### Scratch Size

Scratch space (includes stack):
- `default`: 16MB

Override: `--scratch-size <MB>`

## Plugin Requirements

Profiles can require plugins:

| Profile | Required Plugins |
|---------|-----------------|
| `file-builder` | fs-write |
| `web-research` | fetch, fs-write |

When a profile is applied:
1. Required plugins are enabled if not already
2. Plugin configuration may be prompted
3. Approved plugins skip audit

## When to Use Profiles

### Default (No Profile)

For pure computation:
- Mathematical calculations
- Algorithm implementation
- Data transformation (in memory)
- No file or network access

### file-builder

For generating files:
- ZIP archives
- PowerPoint presentations
- CSV/JSON exports
- Image generation

### web-research

For accessing external data:
- API calls
- Web scraping
- Data pipelines
- Combined with file output

### heavy-compute

For intensive calculations:
- Large datasets
- Cryptographic operations
- Simulations
- Complex algorithms

## Combining with Skills

Profiles provide resources, skills provide knowledge:

```bash
# Build presentations: need file access + PPTX knowledge
hyperagent --profile file-builder --skill pptx-expert

# Web scraping: need network + scraping techniques
hyperagent --profile web-research --skill web-scraper
```

## Custom Limits

Override specific limits without a profile:

```bash
# Extra CPU time
hyperagent --cpu-timeout 5000

# More memory
hyperagent --heap-size 128

# Combined
hyperagent --cpu-timeout 5000 --heap-size 64 --wall-timeout 30000
```

Runtime adjustments:

```
/timeout cpu 5000
/timeout wall 30000
```

## Profile vs Manual Configuration

| Approach | Pros | Cons |
|----------|------|------|
| Profile | Quick, tested combinations | Less flexible |
| Manual | Fine-grained control | More typing |
| Stacked | Best of multiple profiles | Can be overkill |

## Implementation Details

Profiles are defined in `src/agent/profiles.ts`:

```typescript
const profiles: Record<string, Profile> = {
  default: {
    heapSize: 16,
    cpuTimeout: 1000,
    wallTimeout: 5000,
    plugins: []
  },
  "file-builder": {
    heapSize: 64,
    cpuTimeout: 3000,
    wallTimeout: 10000,
    plugins: ["fs-write"]
  },
  // ...
};
```

## See Also

- [SKILLS.md](SKILLS.md) - Domain expertise
- [MODULES.md](MODULES.md) - Available modules
- [USAGE.md](USAGE.md) - CLI reference
- [HOW-IT-WORKS.md](HOW-IT-WORKS.md) - System overview
