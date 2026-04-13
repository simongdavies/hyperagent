# MCP Integration — Threat Model

> **Companion to**: `docs/design/MCP-INTEGRATION-DESIGN.md`
> **Date**: April 2026

## New Trust Boundaries

```
                    EXISTING                           NEW (MCP)
              ┌──────────────────┐              ┌──────────────────────┐
  Untrusted   │ LLM outputs     │              │ MCP server processes │
  Sources     │ Guest JS code   │              │ MCP tool responses   │
              │ Plugin source   │              │ MCP config (user)    │
              └───────┬──────────┘              └──────────┬───────────┘
                      │                                    │
         ┌────────────┴────────────┐          ┌────────────┴────────────┐
         │  SANDBOX (Hyperlight)   │          │  HOST PROCESS (Node.js) │
         │  Hardware-isolated      │          │  Shared address space   │
         └─────────────────────────┘          └─────────────────────────┘
```

The critical difference: **native plugins run inside the HyperAgent
process** with their source audited. **MCP servers are external
processes** with full OS access — they are trusted by the user but not by
HyperAgent.

---

## Native Plugins vs MCP Servers — Security Layers

Native plugins pass through **6 security layers**:

1. Tool gating (whitelist of allowed tools)
2. Hardware isolation (Hyperlight micro-VM)
3. Code validation (pre-execution parse + import checks)
4. Static plugin scanning (regex for `eval`, `spawn`, `child_process`, …)
5. LLM deep audit with canary injection
6. Approval persistence with SHA-256 content hashing

MCP servers pass through **2.5 layers**:

1. Approval gate (interactive prompt with full command display)
2. Sandbox isolation (guest code in the micro-VM cannot escape, even with
   poisoned MCP responses)
3. Namespace validation (half-layer — prevents collision with native
   plugins)

The missing layers (static scan, LLM audit, code validation) do not
apply because **there is no source code to analyse**. The MCP server is
an opaque, user-chosen external process.

This matches the trust model of every other MCP client: VS Code, Claude
Desktop, Cursor, and the Cloudflare Agents SDK.

---

## Threat Table

| ID  | Threat                        | Severity    | Likelihood | Mitigated?                | Residual   |
| --- | ----------------------------- | ----------- | ---------- | ------------------------- | ---------- |
| T1  | Command injection via config  | 🔴 CRITICAL | Medium     | ✅ Approval gate          | Low        |
| T2  | MCP server has full OS access | 🔴 CRITICAL | Low        | ⚠️ Inherent to MCP        | Medium     |
| T3  | Response → prompt injection   | 🟠 HIGH     | Medium     | ✅ Sandbox isolation      | Low        |
| T4  | Env var leakage               | 🟠 HIGH     | Medium     | ✅ Masking + substitution | Low        |
| T5  | Server crash / hang           | 🟡 MEDIUM   | High       | ✅ Timeouts               | Low        |
| T6  | Schema poisoning              | 🟡 MEDIUM   | Low        | ✅ Sanitisation           | Low        |
| T7  | Namespace collision           | 🟡 MEDIUM   | Low        | ✅ Validation             | Negligible |
| T8  | stdio injection               | 🟢 LOW      | Low        | ✅ SDK handles            | Negligible |
| T9  | Server proliferation DoS      | 🟢 LOW      | Low        | ✅ Caps                   | Negligible |
| T10 | Approval file tampering       | 🟡 MEDIUM   | Low        | ✅ Hash-based             | Low        |

---

## Detailed Threats

### T1 — Malicious MCP Server Config (Command Injection)

**Threat**: user (or compromised config file) sets
`command: "rm", args: ["-rf", "/"]` and HyperAgent spawns it.

**Severity**: 🔴 CRITICAL

**Attacker**: config file tampering, social engineering ("add this to
your config…").

**Mitigations**:

- Approval gate: first-use interactive prompt showing exact
  `command + args` before spawn. Command displayed verbatim, not
  interpreted.
- Approval keyed on SHA-256(`name + command + JSON.stringify(args)`) —
  config change invalidates.

**Residual risk**: user approves something they shouldn't. Same as any
tool installation (npm, pip, brew).

---

### T2 — MCP Server Process Escape / Host Compromise

**Threat**: MCP server runs as a full OS process with the user's
permissions. A malicious server can read files, make network requests,
and exfiltrate data. **It is NOT sandboxed.**

**Severity**: 🔴 CRITICAL

**Attacker**: malicious MCP server package (supply chain).

**Mitigations**:

- Approval prompt with full command shown.
- Explicit warning: "⚠️ This MCP server runs as a full OS process with
  YOUR permissions. It is NOT sandboxed."
- Documentation warning.
- Recommend running HyperAgent in Docker for defence-in-depth.
- Future consideration: containerised MCP server spawning.

**Residual risk**: HIGH — inherent to the MCP model. Identical risk
surface to VS Code MCP, Claude Desktop, etc.

---

### T3 — MCP Tool Response Injection (Untrusted Data → LLM)

**Threat**: MCP server returns crafted content containing prompt
injection payloads, attempting to manipulate the LLM into generating
malicious guest code.

**Severity**: 🟠 HIGH

**Attacker**: compromised MCP server, or MCP server proxying
attacker-controlled content (e.g. web scraping MCP).

**Mitigations**:

- Tool responses flow through the sandbox bridge as **data**, not
  instructions. Guest code processes the return value — it is not
  injected into the LLM prompt.
- Existing sandbox isolation (Hyperlight hardware isolation) prevents
  any generated code from escaping, even if the LLM is tricked.
- MCP responses treated as untrusted data in documentation.

**Residual risk**: LOW for sandbox execution. MEDIUM if MCP tool
descriptions are injected into the system message (fetched once at
connection time, not per-call).

---

### T4 — Environment Variable Leakage via MCP Config

**Threat**: MCP config contains `env: { "API_KEY": "sk-live-..." }`.
Could leak through: (a) transcript logs, (b) error messages, (c) system
message injection, (d) approval prompt display.

**Severity**: 🟠 HIGH

**Attacker**: log reader, shoulder surfer, LLM data extraction.

**Mitigations**:

1. **Never log env values** — log env var _names_ only.
2. Approval prompt shows env var names, masks values:
   `API_KEY=sk-l***`.
3. System message includes tool descriptions but **never env values**.
4. Use `${ENV_VAR}` substitution in config so actual values come from
   the OS environment, not the config file on disk.
5. Error messages from MCP client manager are sanitised before
   surfacing.

**Residual risk**: LOW if mitigations applied consistently.

---

### T5 — MCP Server Crash / Hang → Agent Instability

**Threat**: MCP server process crashes, hangs, or produces infinite
output. Guest code blocks waiting for the response.

**Severity**: 🟡 MEDIUM

**Attacker**: buggy MCP server, or deliberate DoS.

**Mitigations**:

1. Timeout on `callTool()` — min(30 s, remaining sandbox wall-clock).
   Configurable per-server.
2. Process health monitoring — detect crash via transport close event,
   set state → `error`, attempt respawn on next call.
3. Sandbox wall-clock timeout still applies — even if MCP call hangs,
   the sandbox execution times out.
4. Response size cap (1 MB default, configurable).

**Residual risk**: LOW — existing sandbox timeout is the safety net.

---

### T6 — MCP Tool Schema Poisoning (Type Generation Attack)

**Threat**: MCP server returns tool schemas with malicious descriptions
or crafted names designed to confuse the LLM or inject into generated
TypeScript declarations (e.g. tool named `"); process.exit(0); ("`).

**Severity**: 🟡 MEDIUM

**Attacker**: malicious MCP server.

**Mitigations**:

1. Sanitise tool names — strip non-alphanumeric characters
   (`[a-zA-Z_$][a-zA-Z0-9_$]*` only).
2. Sanitise descriptions — escape `*/` for JSDoc, strip ANSI escape
   codes, truncate to 2 000 chars.
3. Generated `.d.ts` is never `eval()`'d — used as type context for the
   LLM, not executed.
4. Tool names used as function names in host module registration are
   validated as valid JS identifiers.

**Residual risk**: LOW — generated types are informational, not
executable.

---

### T7 — Namespace Collision

**Threat**: MCP server named `fs-read` or returning a module that
collides with `host:fs-read`, allowing MCP to intercept native plugin
calls.

**Severity**: 🟡 MEDIUM

**Attacker**: malicious config or MCP server.

**Mitigations**:

1. Separate namespace: `mcp:` prefix distinct from `host:`.
2. Reject MCP server names matching existing plugin names.
3. Reject MCP server names matching reserved prefixes (`ha:`, `host:`).
4. Validate at config parse time, not connection time.

**Residual risk**: NEGLIGIBLE if validation implemented.

---

### T8 — stdio Transport Injection

**Threat**: MCP server writes non-JSON-RPC data to stdout (ANSI escape
sequences, log spam) that corrupts the transport parser.

**Severity**: 🟢 LOW

**Attacker**: buggy MCP server.

**Mitigations**: `@modelcontextprotocol/client`'s `StdioClientTransport`
handles framing and parsing. Malformed messages throw `ProtocolError`.
The SDK is battle-tested (12k+ stars, used by Claude Desktop).

**Residual risk**: NEGLIGIBLE.

---

### T9 — Denial of Service via MCP Server Proliferation

**Threat**: config contains 50+ servers. Even lazy-spawned, if the LLM
tries many simultaneously → resource exhaustion (PIDs, memory, FDs).

**Severity**: 🟢 LOW

**Attacker**: misconfiguration.

**Mitigations**:

1. Cap max configured servers: 20 (rejected at parse time).
2. Cap concurrent connections: 5 (rejected at runtime).
3. Lazy spawn means only active servers consume resources.

**Residual risk**: NEGLIGIBLE with caps.

---

### T10 — Approval Bypass via Config File Manipulation

**Threat**: attacker modifies `~/.hyperagent/config.json` to add a
malicious MCP server and `~/.hyperagent/approved-mcp.json` to
pre-approve it.

**Severity**: 🟡 MEDIUM

**Attacker**: local privilege escalation, shared system.

**Mitigations**:

1. Approval keyed on `name + command + args` hash — attacker must know
   exact config to forge.
2. If attacker has write access to `~/.hyperagent/`, they already have
   user-level access (same threat model as VS Code).
3. File permissions should be 0600 (owner-only).
4. Future consideration: HMAC-based approval signatures.

**Residual risk**: LOW — if attacker has local file write as your user,
MCP config is the least of your problems.

---

## Security Controls Checklist for Operators

1. **Review MCP server packages** before configuring — the server runs
   with your full OS permissions.
2. **Use `${ENV_VAR}` substitution** in config — keep secrets in
   environment variables, not on disk.
3. **Enable only needed servers** — each adds attack surface.
4. **Run in Docker** for defence-in-depth (non-root container).
5. **Monitor logs** at `~/.hyperagent/logs/` — env var values will
   never appear, but connection failures and tool errors are logged.
6. **Clear approvals** if system is compromised:
   `rm ~/.hyperagent/approved-mcp.json`.
7. **Check file permissions** on `~/.hyperagent/` — should be 0700.
