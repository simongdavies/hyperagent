---
name: two-handler-pipeline
description: Research data then build output using separate handlers linked via ha:shared-state
modules: [shared-state]
profiles: []
---

1. Register a RESEARCH handler that collects/processes data and stores results in ha:shared-state
2. Register a BUILD handler that reads from ha:shared-state and produces output
3. Execute research handler first — it populates shared-state with collected data
4. Execute build handler — it reads shared-state and generates the final output
5. Use ha:shared-state for cross-handler data (call module_info for API)
6. ha:shared-state survives handler recompilation — safe across register_handler calls
7. Keep handlers small (~4KB each) — large handlers hit input buffer limits
8. Module-level state (let/const) resets on recompile — only shared-state persists
