# HyperAgent IPC Protocol (`--ipc-stdio`)

> **Audience:** authors of host processes that embed HyperAgent — the
> Electron desktop shell, IDE plugins, remote control planes, test
> harnesses, etc.

When started with `--ipc-stdio`, HyperAgent runs as a headless NDJSON
server instead of an interactive REPL. The host owns stdin and
stdout; every byte in both directions is a single JSON object
followed by a single `\n`.

The same wire format is also used by the in-process `JsonLinesUI`
class (`src/agent/ui/json-lines-ui.ts`), so tests and embedders that
don't need a child-process boundary can speak the protocol in-memory.

## Quick start

```bash
hyperagent --ipc-stdio
```

The agent inherits stdin/stdout of the spawning process. From the
host's perspective:

* **Read** newline-delimited JSON from the agent's stdout — every
  visible side-effect (text, reasoning, tool calls, notifications,
  modal prompts, …) arrives as one event frame.
* **Write** newline-delimited JSON to the agent's stdin — user input,
  modal replies, abort, shutdown.

stderr is left alone for raw crash output. Logs continue to land in
`~/.hyperagent/logs/`.

`--ipc-stdio` is **mutually exclusive** with `--prompt` and
`--prompt-file` — send a `user-input` frame instead. Combining them
exits with code `1` at parse time.

The flag also honours the `HYPERAGENT_IPC_STDIO=1` environment variable
for sandboxes that can't easily set CLI args (e.g. some IDE plugin
hosts).

## Frame shape

Every frame is a single JSON object on one line, UTF-8 encoded, with a
trailing `\n`. Three header fields are present on every frame; the
remaining shape is event-specific.

```json
{ "v": 1, "t": "<event-tag>", "data": <payload> }
```

| Field | Type     | Notes                                                            |
| ----- | -------- | ---------------------------------------------------------------- |
| `v`   | `1`      | Protocol version. Bumped on any backwards-incompatible change.    |
| `t`   | `string` | Event tag, kebab-case. See the event catalogue below.            |
| `data`| any      | Payload object. **Omitted** entirely on payload-less frames.     |

`null` is meaningful: an `activity` frame with `data: null` means
"clear the activity indicator". Payload-less frames (e.g. `begin-turn`)
omit `data` so the consumer can distinguish the two cases.

The TypeScript surface that produces this format lives in
[`src/agent/ui/json-lines-ui.ts`](../src/agent/ui/json-lines-ui.ts) and
the payload type definitions live in
[`src/agent/ui/events.ts`](../src/agent/ui/events.ts).

## Lifecycle

1. The host spawns `hyperagent --ipc-stdio` (or pipes a sub-process).
2. The agent boots — plugins audit, MCP gateway initialises, session
   is created. Bootstrapping notifications stream out as `notification`
   frames during this window.
3. The agent emits one `ready` frame announcing the protocol version,
   agent build, and selected model. Hosts must wait for this frame
   before sending `user-input` — frames sent earlier may race the
   stdin reader setup.
4. The agent waits for a `user-input` frame on stdin. The host sends
   one whenever the user submits a turn.
5. While a turn is in flight the agent streams events on stdout. Modal
   prompts (`ask-approval`, `ask-choice`, `ask-text`, `ask-inline`)
   pause the turn until the host posts a matching `*-response` reply.
6. The turn finishes — a final `markdown` frame carries the assistant
   text, `usage` reports tokens/cost, and the loop returns to step 4.
7. The host sends a `shutdown` frame (or closes stdin) to exit the
   loop cleanly. The agent cancels any pending modals with safe
   defaults (`approval → "no"`, text/inline → `""`, choice →
   `{ answer: "", wasFreeform: false }`) and resolves the loop promise.

## Sequencing rules

* **One turn in flight at a time.** A second `user-input` frame
  arriving while the first turn is processing is queued and runs
  after the current turn finishes. Hosts that want to keep their UI
  responsive can buffer locally and submit one frame at a time.
* **Modal replies are out-of-band.** A modal `ask-*` frame can land
  in the middle of a streaming turn; the matching `*-response` frame
  can be posted any time afterwards. Modal correlation is by `id`
  (UUIDv4 by default) — see [Modal prompts](#modal-prompts).
* **`abort` is best-effort.** It maps to the same code path as the
  ESC key in the REPL: the agent sets the cancellation flag, calls
  `session.abort()` on the SDK, and force-resolves the pending turn
  after a 3 s grace period if the abort event never arrives. The
  current turn may still emit a tail of stale events before unwinding.
* **`shutdown` waits for the queue to drain.** Any user-input turns
  already in flight or queued run to completion before the loop
  resolves. Send `abort` first if you need to break out fast.
* **Malformed frames never crash.** Bad JSON, missing tags, unknown
  tags, or schema mismatches all emit an `error`-level `notification`
  frame and the loop continues.

## Outbound event catalogue (agent → host)

Each row lists the `t` tag, a one-line summary, and the shape of the
`data` payload. Payload field types are listed inline; an `?` suffix
marks an optional field.

### Bootstrap handshake

| Tag     | Description                                  | Payload                                                                                |
| ------- | -------------------------------------------- | -------------------------------------------------------------------------------------- |
| `ready` | One-shot: agent finished booting, stdin attached | `{ protocolVersion: number, agentVersion: string, model: string }`                 |

`ready` is emitted exactly once per agent process, after the boot
sequence and immediately before the stdin reader is wired up. The
fields let the host fail fast on a protocol-version mismatch and
display the selected model/build in its chrome before the first
turn. Hosts that send `user-input` before this frame arrives are
racing the reader and may have their input dropped.

### Streaming output

| Tag                     | Description                                          | Payload                                                                                            |
| ----------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `text-delta`            | Streamed chunk of assistant text                     | `{ content: string }` — never emitted with empty content                                           |
| `reasoning-delta`       | Streamed chunk of model reasoning                    | `{ content: string }` — never emitted with empty content                                           |
| `reasoning-transition`  | End of reasoning, start of response                  | `{ showBanner?: boolean, indent?: string, nextActivity?: string }`                                 |
| `clear-reasoning-buffer`| Drop any in-flight reasoning preview                 | _omitted — payload-less marker frame_                                                              |
| `verbose-reasoning`     | Verbose-reasoning toggle changed                     | `{ value: boolean }`                                                                               |
| `markdown`              | Final assistant message — raw markdown source        | `{ source: string }` — emitted once per turn; never with empty source                              |

### Tool calls

| Tag           | Description                       | Payload                                                                                                                                                                                                                                                                                       |
| ------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool-start`  | A tool call has begun             | `{ name: string, callId: string }`                                                                                                                                                                                                                                                            |
| `tool-result` | A tool call has finished          | `{ name: string, callId: string, status: "success" \| "error" \| "denied", message: string, body?: { kind: "text" \| "json" \| "markdown", content: string }, hint?: string, silent?: boolean }`                                                                                              |

### Status / activity

| Tag            | Description                                                | Payload                                                                                                                                                          |
| -------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `begin-turn`   | New turn starting — reset elapsed timer                    | _omitted — payload-less marker frame_                                                                                                                            |
| `activity`     | Activity indicator changed (`data: null` means "clear it") | `null` _or_ `{ kind: "thinking" \| "planning" \| "reasoning" \| "tool" \| "compacting" \| "waiting" \| "nudging" \| "custom", label: string, detail?: string }`  |
| `window-title` | Set the host window title                                  | `{ title: string }`                                                                                                                                              |

### Notifications

| Tag            | Description                                                 | Payload                                                                                                            |
| -------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `notification` | One-shot info / warning / error / success / plain line      | `{ level: "info" \| "warning" \| "error" \| "success" \| "plain", kind: <semantic tag>, icon?: string, message: string, indent?: string }` |

`kind` is a semantic tag that lets richer UIs route specific events
to dedicated affordances (e.g. `context_compacted` could trigger a
toast). Known values: `generic`, `keep_alive_nudge`, `context_compacted`,
`context_compaction_failed`, `context_truncated`, `context_usage`,
`task_complete`, `model_change`, `session_resume`, `session_stats`,
`sdk_warning`, `sdk_info`, `sdk_error`, `buffer_overflow_hint`,
`audit_phase`, `audit_receiving`, `extended_reasoning`,
`pending_attachments`, `plugin_config`. Unknown kinds fall through to
the level's default styling.

### Usage stats

| Tag     | Description                                  | Payload                                                                                                                                                                  |
| ------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `usage` | Tokens / cost / duration for the last call   | `{ model?: string, inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number, cost?: number, durationMs?: number, indent?: string }` |

### Modal prompts

These frames pause the turn until the host posts a matching
`*-response` inbound frame. The agent generates a UUIDv4 `id` for
each prompt; the host must echo it back unchanged so the agent can
route the reply to the correct pending await.

| Tag            | Description                                | Payload                                                                                                                          |
| -------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `ask-approval` | Yes/no confirmation prompt                 | `{ id: string, question: string, kind?: <approval-kind>, defaultChoice?: "yes" \| "no" }`                                        |
| `ask-choice`   | Multiple-choice prompt with optional freeform | `{ id: string, question: string, choices: string[], allowFreeform?: boolean, kind?: string }`                                |
| `ask-text`     | Freeform text prompt                       | `{ id: string, question: string, hint?: string, kind?: string }`                                                                 |
| `ask-inline`   | Inline prompt (terminal cursor-style)      | `{ id: string, prompt: string }`                                                                                                 |

`<approval-kind>` is one of: `generic`, `ask_user`, `plugin_audit`,
`module_register`, `module_delete`, `skill_save`, `skill_delete`,
`mcp_server`, `profile_apply`, `limits_apply`, `resume_session`.

When the host disconnects (stdin EOF, `shutdown` frame), every
outstanding modal is resolved with its safe default — see the
[Lifecycle](#lifecycle) section above.

## Inbound frame catalogue (host → agent)

| Tag                  | Description                                            | Payload                                                                                                                                |
| -------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `user-input`         | Submit a turn (text + optional attachments)            | `{ text: string, attachments?: SessionAttachment[] }`                                                                                  |
| `approval-response`  | Reply to a pending `ask-approval`                      | `{ id: string, choice: "yes" \| "no" }`                                                                                                |
| `choice-response`    | Reply to a pending `ask-choice`                        | `{ id: string, answer: string, wasFreeform?: boolean }`                                                                                |
| `text-response`      | Reply to a pending `ask-text`                          | `{ id: string, answer: string }`                                                                                                       |
| `inline-response`    | Reply to a pending `ask-inline`                        | `{ id: string, answer: string }`                                                                                                       |
| `abort`              | Cancel the in-flight turn (same as ESC in REPL mode)   | _omitted — payload-less marker frame_                                                                                                  |
| `shutdown`           | Drain the queue then exit cleanly                      | _omitted — payload-less marker frame_                                                                                                  |

### Attachments

`user-input.attachments` carries SDK-shape attachment objects verbatim.
Four discriminated kinds are supported by the underlying Copilot SDK
(`@github/copilot-sdk`):

| `type`        | Description                                | Required fields                                                  |
| ------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| `"file"`      | Absolute filesystem path the agent reads   | `{ type, path: string, displayName?: string }`                   |
| `"directory"` | Filesystem directory the agent walks       | `{ type, path: string, displayName?: string }`                   |
| `"selection"` | Pre-extracted text snippet                 | `{ type, content: string, displayName?: string, language?: string }` |
| `"blob"`      | Inline binary (base64) with a MIME type    | `{ type, data: string, mimeType: string, displayName?: string }` |

The Electron desktop shell uses `blob` for paste-from-clipboard images:
the renderer base64-encodes the PNG bytes and embeds them directly in
the `user-input` frame so the agent never sees the host's filesystem.

The agent does a cheap pre-flight (drop entries with no string `type`
field, emit a warning notification per drop) and hands the rest to
the SDK for full validation. The downstream SDK does the heavy lifting
— size limits, MIME sniffing, etc.

## Example: full transcript

A minimal "one turn, one approval prompt, then shutdown" exchange:

```text
# agent → host (stdout)
{"v":1,"t":"notification","data":{"level":"info","kind":"sdk_info","message":"Session started"}}

# host → agent (stdin)
{"t":"user-input","data":{"text":"What's the time?"}}

# agent → host
{"v":1,"t":"begin-turn"}
{"v":1,"t":"activity","data":{"kind":"thinking","label":"Thinking..."}}
{"v":1,"t":"reasoning-delta","data":{"content":"User wants the current time."}}
{"v":1,"t":"reasoning-transition"}
{"v":1,"t":"tool-start","data":{"name":"execute_javascript","callId":"call-1"}}
{"v":1,"t":"ask-approval","data":{"id":"7c3f…","question":"Run JavaScript? [Y/n]","kind":"generic","defaultChoice":"yes"}}

# host → agent
{"t":"approval-response","data":{"id":"7c3f…","choice":"yes"}}

# agent → host
{"v":1,"t":"tool-result","data":{"name":"execute_javascript","callId":"call-1","status":"success","message":"Done"}}
{"v":1,"t":"markdown","data":{"source":"It's 14:23 UTC."}}
{"v":1,"t":"usage","data":{"model":"gpt-4o","inputTokens":312,"outputTokens":18,"durationMs":1820}}
{"v":1,"t":"activity","data":null}

# host → agent
{"t":"shutdown"}
```

The agent's loop resolves cleanly and the process exits with code 0.

## Error handling

Every malformed inbound frame produces an `error`-level `notification`
on stdout and the loop continues. The agent never crashes on a bad
frame because:

* The host is trusted to send well-formed frames in normal operation.
* A protocol slip on either side should be diagnosable, not fatal.
* Hosts that lose track of their own modal IDs (e.g. after a reload)
  must not be able to wedge the agent.

Specific error cases the agent surfaces:

* `IPC: malformed JSON (<message>)` — `JSON.parse` failed.
* `IPC: frame missing "t" tag` — top-level shape mismatch.
* `IPC: user-input frame missing text` — required field absent.
* `IPC: dropping attachment <i> — missing "type"` — bad attachment
  entry. Warning, not error; the turn still runs with the valid ones.
* `IPC: approval-response missing id/choice` (and analogues for the
  other modal responses) — required field absent or wrong type.
* `IPC: unknown frame tag` — forward-compatible drop (the host is
  emitting a tag from a newer protocol version).
* `Turn failed: <message>` — `processMessage` threw. The turn aborts,
  the loop continues.

The agent never *initiates* a connection close as a way to report an
error. It always emits a notification first, then continues waiting
for the host to either retry or send `shutdown`/`abort`.

## Versioning

The `v` field on every frame is the protocol version. Today it is `1`.
The agent and host must agree on the major version. Backwards-
compatible additions (new optional fields, new event tags, new
notification kinds) do not bump `v`; the only way to see a bump is a
breaking change to an existing frame's required shape.

Hosts SHOULD drop unknown event tags silently rather than failing — the
agent does the same on the inbound side. New optional fields SHOULD
default to a safe behaviour when absent.

## Reference implementation

* **Outbound serialiser:** [`src/agent/ui/json-lines-ui.ts`](../src/agent/ui/json-lines-ui.ts) — every `AgentUI` method
  maps directly to a `JsonLinesUI._emit(<tag>, <payload>)` call.
* **Inbound dispatcher:** [`src/agent/ipc-stdio-loop.ts`](../src/agent/ipc-stdio-loop.ts) — single
  `switch (frame.t)` on each stdin line, with the route table mirroring
  the table above.
* **Bootstrap fork:** [`src/agent/index.ts`](../src/agent/index.ts) — search for
  `cli.ipcStdio` to see how the headless mode replaces the readline
  REPL.
* **CLI flag:** [`src/agent/cli-parser.ts`](../src/agent/cli-parser.ts) — `--ipc-stdio` and the
  `HYPERAGENT_IPC_STDIO=1` env var.
* **Wire-format tests:** [`tests/json-lines-ui.test.ts`](../tests/json-lines-ui.test.ts)
  (per-frame shape) and [`tests/ipc-stdio-loop.test.ts`](../tests/ipc-stdio-loop.test.ts)
  (dispatch behaviour).
