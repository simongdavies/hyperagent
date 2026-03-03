---
name: data-transformation
description: Transform, filter, and aggregate data using event dispatch
modules: [shared-state, str-bytes, base64, markdown]
profiles: [heavy-compute]
cpuTimeoutMs: 10000
---

1. Register a handler with event dispatch pattern (event.action)
2. Pass input data via event parameter — avoid hardcoding data in handler code
3. For large datasets: process in chunks, accumulate results across calls
4. Use module-level state (let/var) to accumulate results across event dispatch calls
5. Return transformed data as JSON from the handler
6. If results need to persist across handler recompilation, use ha:shared-state
7. For very large results: write to file via fs-write plugin instead of returning JSON
