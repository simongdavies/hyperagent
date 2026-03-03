# Source Directory

Core Hyperagent implementation.

## Subdirectories

### `agent/`
Main agent REPL and supporting utilities:
- `state.ts` — Typed mutable state container for the agent
- `commands.ts` — Slash command implementations
- `system-message.ts` — LLM system prompt generation
- `skill-loader.ts` — Loads skills from `skills/` directory
- `tool-gating.ts` — Permission system for tools
- `analysis-guest.ts` — Static analysis via Rust guest

### `plugin-system/`
Plugin discovery, loading, and security:
- `manager.ts` — Plugin lifecycle management
- `auditor.ts` — Static security analysis of plugins
- `types.ts` — TypeScript types for plugin system

### `sandbox/`
Hyperlight sandbox integration:
- `tool.d.ts` — Type definitions for sandbox tools

### `code-validator/`
Rust-based static analysis:
- `guest/` — Rust code compiled to run in Hyperlight
- Contains its own `Cargo.toml` and Rust project structure

## Conventions

- All agent state flows through `AgentState` interface (see `agent/state.ts`)
- No module-level mutable state — pass state explicitly
- TypeScript strict mode enabled
