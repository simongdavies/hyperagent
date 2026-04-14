# Phase 10: Quality Loop CI — Design Plan

## Overview

A generic, config-driven continuous improvement loop that:
1. Runs prompts against HyperAgent modules (PDF, future DOCX, etc.)
2. Validates outputs (structural, visual, content, feedback extraction)
3. Deduplicates findings into tracked GitHub Issues
4. Auto-assigns top 3 issues (by frequency) to Copilot Workspace for fixing
5. Loops after fixes are merged

## Architecture: Same Repo, Watch Paths in Module Config

- Quality loop is a GitHub Actions workflow in hyperagent
- Issues tracked with `quality-loop` + module labels
- Copilot Workspace creates PRs from `copilot-fix` issues
- Module detection: orchestrator reads module configs, compares `watch_paths` against git diff
- Adding a new module = adding a config file + prompts, no workflow changes

## Module Config Format

Each module registers itself via a config file:

```yaml
# quality-loop/modules/pdf.yaml
name: pdf
skill: pdf-expert
profiles: file-builder
prompts_dir: tests/pdf-prompts
expected_patterns:
  - "*.yaml"
watch_paths:
  - builtin-modules/src/pdf.ts
  - builtin-modules/src/pdf-charts.ts
  - builtin-modules/src/doc-core.ts
  - skills/pdf-expert/
  - tests/pdf-prompts/
  - src/agent/**          # core changes trigger all modules
  - src/sandbox/**
validation:
  structural: true      # qpdf --check
  visual: true          # pdftoppm + pixelmatch against golden
  content: true         # expected_content field matching
  feedback: true        # extract LLM feedback JSON
  text_extraction: true # pdftotext for custom font docs
timeout: 300            # per-prompt timeout in seconds
```

Future DOCX module:
```yaml
# quality-loop/modules/docx.yaml
name: docx
skill: docx-expert
profiles: file-builder
prompts_dir: tests/docx-prompts
watch_paths:
  - builtin-modules/src/docx.ts
  - skills/docx-expert/
  - tests/docx-prompts/
  - src/agent/**
  - src/sandbox/**
validation:
  structural: true
  content: true
  feedback: true
timeout: 300
```

## Pipeline Stages

### Stage 1: Run Prompts
- For each module config, run all prompts via generalized `run-prompts.sh`
- Collect: output files, debug logs, code logs, transcripts, feedback JSON
- Output: `/tmp/quality-loop-results/<run-id>/<module>/<prompt>/`

### Stage 2: Validate & Score
For each prompt result:
- **Structural**: qpdf/file header/EOF checks → pass/fail
- **Content**: expected_content field matches → score (found/total)
- **Visual**: pixelmatch against golden baselines → diff pixel count
- **Feedback**: extract LLM feedback JSON → parse errors/hard/improvements
- **Text extraction**: pdftotext output sanity check
- **Code analysis**: read code.log for patterns (unused imports, error recovery attempts)
- **Timing**: duration, number of LLM edits/retries

Output: `evaluation-report.json` per prompt

### Stage 3: Deduplicate & Track Issues
- Parse all evaluation reports + feedback across all prompts
- Group findings by category:
  - `bug`: runtime errors, qpdf failures, visual regressions
  - `api-gap`: missing features reported by 2+ prompts
  - `ux-friction`: confusing APIs, misleading types, extra LLM attempts needed
  - `performance`: slow prompts, excessive retries
- For each finding:
  - Hash the finding (category + description + key details) → fingerprint
  - Check existing GitHub Issues with label `quality-loop` for matching fingerprint
  - If exists: increment occurrence count in issue body, add latest evidence
  - If new: create new issue with label `quality-loop`, priority tag, evidence

### Stage 4: Prioritize & Assign
- Score issues by: frequency × severity × recency
- Top 3 issues by score → assign to Copilot Workspace
  - Add label `copilot-fix`
  - Issue body includes: reproduction steps, relevant code paths, suggested fix
- Remaining issues: labelled `quality-loop-backlog`

### Stage 5: Fix & Merge
- Copilot Workspace creates PRs from `copilot-fix` issues
- PRs run standard CI (`just check`)
- Human reviews and merges
- On merge → quality loop runs again (triggered by merge event + watch_paths match)

## Workflow Definition

```yaml
name: Quality Loop
on:
  workflow_dispatch:
    inputs:
      modules:
        description: "Comma-separated module names (or 'all')"
        default: "all"
      max_iterations:
        description: "Max improvement iterations"
        default: "1"
  schedule:
    - cron: "0 2 * * 1-5"  # Weekday 2am
  push:
    branches: [main]
    paths:
      - "builtin-modules/src/**"
      - "skills/**"
      - "src/agent/**"
      - "src/sandbox/**"
      - "quality-loop/modules/**"

jobs:
  detect-modules:
    runs-on: ubuntu-latest
    outputs:
      modules: ${{ steps.detect.outputs.modules }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2
      - id: detect
        run: |
          node scripts/quality-loop/detect-modules.mjs \
            --changed "$(git diff --name-only HEAD~1)" \
            >> "$GITHUB_OUTPUT"

  quality-loop:
    needs: detect-modules
    if: needs.detect-modules.outputs.modules != 'none'
    runs-on:
      - self-hosted
      - 1ES.Pool=hld-kvm-amd
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    steps:
      - uses: actions/checkout@v4
      - name: Setup
        run: |
          sudo apt-get update
          sudo apt-get install -y poppler-utils qpdf fonts-dejavu-core
          just setup
      - name: Build
        run: just build
      - name: Run quality loop
        run: |
          node scripts/quality-loop/orchestrator.mjs \
            --modules "${{ needs.detect-modules.outputs.modules }}" \
            --max-iterations "${{ inputs.max_iterations || '1' }}"
      - name: Upload results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: quality-loop-${{ github.run_number }}
          path: /tmp/quality-loop-results/
          retention-days: 30
```

## Scripts

| Script | Purpose | ~LOC |
|--------|---------|------|
| `scripts/quality-loop/orchestrator.mjs` | Main entry: load module configs, run stages, loop | ~100 |
| `scripts/quality-loop/detect-modules.mjs` | Compare changed files against watch_paths | ~60 |
| `scripts/quality-loop/runner.mjs` | Stage 1: execute prompts for a module | ~80 |
| `scripts/quality-loop/evaluator.mjs` | Stage 2: validate outputs, generate scores | ~150 |
| `scripts/quality-loop/deduplicator.mjs` | Stage 3: group findings, manage GitHub Issues | ~200 |
| `scripts/quality-loop/prioritizer.mjs` | Stage 4: score issues, assign top 3 to Copilot | ~80 |
| `scripts/quality-loop/reporter.mjs` | Generate HTML summary report | ~100 |

## Issue Format

```markdown
## Quality Loop Finding: [category] [title]

**Module:** pdf
**Priority:** P0 | P1 | P2
**Occurrences:** 3 (across 3 runs)
**Fingerprint:** `sha256:abc123...`

### Description
[What's wrong]

### Evidence
- Run 2026-04-14 #42: invoice.yaml — [details]
- Run 2026-04-13 #41: letter.yaml — [details]
- Run 2026-04-12 #40: resume.yaml — [details]

### Suggested Fix
[Code paths to change, approach]

### Reproduction
\```bash
./scripts/run-pdf-prompts.sh invoice.yaml
# Then check: ...
\```

Labels: `quality-loop`, `pdf`, `P0`
```

## Stop Conditions
- All prompts score ≥ 90% on all metrics
- No new issues found in 2 consecutive runs
- Max iterations reached (configurable)
- Zero P0 issues remain open

## Key Design Principles
1. **Generic**: module configs make it work for any document type
2. **Idempotent**: same run twice → same issues (deduplication via fingerprint)
3. **Observable**: HTML report, GitHub Issues, artifact uploads
4. **Safe**: never auto-merges, always needs human review for PRs
5. **Incremental**: fixes top 3 issues per iteration, not everything at once
