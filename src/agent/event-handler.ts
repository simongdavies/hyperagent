// ── agent/event-handler.ts — Session event handler ───────────────────
//
// Extracted from agent.ts. Contains registerEventHandler(),
// resetKeepAliveTimer(), clearKeepAliveState(), and
// sendAndWaitWithKeepAlive().
// ─────────────────────────────────────────────────────────────────────

import type {
  CopilotSession,
  AssistantMessageEvent,
} from "@github/copilot-sdk";
import type { AgentState } from "./state.js";
import type { Spinner } from "./spinner.js";
import { looksLikeMarkdown } from "./markdown-renderer.js";
import { buildBufferOverflowHint } from "./buffer-overflow.js";
import type { createSandboxTool } from "../sandbox/tool.js";
import type { AgentUI, ToolResultPayload } from "./ui/index.js";

// ── Types ────────────────────────────────────────────────────────────

/** Runtime dependencies for the event handler */
export interface EventHandlerDeps {
  state: AgentState;
  spinner: Spinner;
  /**
   * Display port — every user-visible byte goes through here.
   * Phase 4 will absorb the spinner into the UI; until then
   * both deps are present and `spinner` is used for internal
   * state (resetTurnStart, clearReasoning, reasoningLength,
   * progress label updates) that the port does not yet cover.
   */
  ui: AgentUI;
  sandbox: ReturnType<typeof createSandboxTool>;
  SEND_TIMEOUT_MS: number;
  MAX_INACTIVITY_RETRIES: number;
  debugLog: (msg: string) => void;
}

// ── Keep-Alive State ─────────────────────────────────────────────────

/** Map toolCallId -> toolName for correlating start/complete events. */
const pendingTools = new Map<string, string>();

// ── Tool-result payload helpers ──────────────────────────────────────

/**
 * Threshold above which large JSON object results are rendered as a
 * multi-line body instead of inline with the status message.
 * Matches the original `tool.execution_complete` switch.
 */
const VERBOSE_RESULT_INLINE_LIMIT = 500;

/**
 * Build a `ToolResultPayload` for the verbose-mode "successful result
 * with `parsed.result` present" branch.
 *
 * The branching mirrors the original switch faithfully:
 *
 *   - String containing `\n` → multi-line body (markdown if both
 *     enabled and content looks like markdown, otherwise dimmed
 *     text).
 *   - String without `\n` → inline `"Result: <value>"` message.
 *   - Object pretty-printed > 500 chars → multi-line body (markdown
 *     `json` fence when markdown enabled, otherwise dimmed text).
 *   - Object ≤ 500 chars → inline `"Result: <pretty>"` message (the
 *     pretty JSON is included in the message; the colour wrap
 *     extends to the value, a deliberate single-emit simplification
 *     of the original two-colour split, since this branch is not
 *     golden-tested).
 *   - Anything else (booleans, numbers, etc.) → `"Result: <String(v)>"`.
 *
 * The caller is responsible for the surrounding tool-success header
 * (icon) — `emitToolResult` adds it from the `status` field.
 */
function buildVerboseResultPayload(
  toolName: string,
  callId: string,
  displayValue: unknown,
  markdownEnabled: boolean,
): ToolResultPayload {
  if (typeof displayValue === "string") {
    if (displayValue.includes("\n")) {
      // Multi-line string: separate body line beneath the header.
      const useMarkdown = markdownEnabled && looksLikeMarkdown(displayValue);
      return {
        name: toolName,
        callId,
        status: "success",
        message: "Result:",
        body: {
          kind: useMarkdown ? "markdown" : "text",
          content: displayValue,
        },
      };
    }
    return {
      name: toolName,
      callId,
      status: "success",
      message: `Result: ${displayValue}`,
    };
  }
  if (displayValue !== null && typeof displayValue === "object") {
    const pretty = JSON.stringify(displayValue, null, 2);
    if (pretty.length > VERBOSE_RESULT_INLINE_LIMIT) {
      // Large object: multi-line body. Wrap in a JSON code fence when
      // markdown is enabled so the renderer can apply syntax colour;
      // otherwise emit dimmed pretty-printed text.
      return {
        name: toolName,
        callId,
        status: "success",
        message: "Result:",
        body: markdownEnabled
          ? { kind: "markdown", content: "```json\n" + pretty + "\n```" }
          : { kind: "text", content: pretty },
      };
    }
    // Small object: inline pretty-print on the header line.
    return {
      name: toolName,
      callId,
      status: "success",
      message: `Result: ${pretty}`,
    };
  }
  // Booleans, numbers, etc.
  return {
    name: toolName,
    callId,
    status: "success",
    message: `Result: ${String(displayValue)}`,
  };
}

/** Reset the keep-alive inactivity timer. Called on EVERY event. */
export function resetKeepAliveTimer(deps: EventHandlerDeps): void {
  const { state, SEND_TIMEOUT_MS } = deps;
  // Don't start/reset the timer if:
  // - No pending promise (not waiting for model response)
  // - Waiting for user input (approval prompts, config questions, etc.)
  if (!state.pendingReject || state.waitingForUserInput) return;
  if (state.keepAliveTimeoutId) clearTimeout(state.keepAliveTimeoutId);
  const inactivityMs = state.sendTimeoutOverride ?? SEND_TIMEOUT_MS;
  state.keepAliveTimeoutId = setTimeout(() => {
    deps.debugLog(
      `TIMEOUT fired: inactivityRetryCount=${state.inactivityRetryCount}, pendingReject=${!!state.pendingReject}`,
    );
    if (
      state.inactivityRetryCount < deps.MAX_INACTIVITY_RETRIES &&
      state.activeSession
    ) {
      state.inactivityRetryCount++;
      const totalSecs = Math.round(inactivityMs / 1000);
      const timeStr =
        totalSecs >= 60
          ? `${Math.floor(totalSecs / 60)}m ${totalSecs % 60}s`
          : `${totalSecs}s`;
      deps.ui.emitNotification({
        level: "info",
        kind: "keep_alive_nudge",
        icon: "⏳",
        message: `No activity for ${timeStr} — nudging model to continue...`,
      });
      deps.ui.setActivity({
        kind: "waiting",
        label: "Waiting for response...",
      });
      state.activeSession
        .send({
          prompt:
            "The user is still here. Please continue — do not repeat what you already said.",
        })
        .catch(() => {});
      resetKeepAliveTimer(deps);
      return;
    }

    const reject = state.pendingReject;
    clearKeepAliveState(deps);
    const totalSecs = Math.round(inactivityMs / 1000);
    const timeStr =
      totalSecs >= 60
        ? `${Math.floor(totalSecs / 60)}m ${totalSecs % 60}s`
        : `${totalSecs}s`;
    reject?.(
      new Error(
        `The model stopped responding (${timeStr} with no activity). ` +
          `The session may be stale — try sending your message again ` +
          `or use /new for a fresh session.`,
      ),
    );
  }, inactivityMs);
}

/** Clear all keep-alive state. */
export function clearKeepAliveState(deps: EventHandlerDeps): void {
  const { state } = deps;
  if (state.keepAliveTimeoutId) clearTimeout(state.keepAliveTimeoutId);
  state.keepAliveTimeoutId = null;
  state.pendingResolve = null;
  state.pendingReject = null;
}

// ── Event Handler ────────────────────────────────────────────────────

/**
 * Register the event handler on a session. Handles display (deltas,
 * tool calls) and flow control (session idle/error for keep-alive).
 */
export function registerEventHandler(
  session: CopilotSession,
  deps: EventHandlerDeps,
): void {
  const { state, spinner, sandbox, debugLog } = deps;

  if (state.eventHandlerUnsub) {
    state.eventHandlerUnsub();
    state.eventHandlerUnsub = null;
  }
  clearKeepAliveState(deps);

  const myGeneration = ++state.handlerGeneration;

  // Workaround: every SessionEvent has a unique `id: string`.
  // We track seen IDs in a Map and drop events we've already
  // dispatched. The Map is bounded by evicting entries older than
  // DEDUP_WINDOW_MS to prevent unbounded memory growth.
  //
  const anySession = session as any;
  if (!anySession.__dedupPatched) {
    const origDispatch = anySession._dispatchEvent.bind(anySession);

    /** Seen event IDs with their timestamp for eviction. */
    const seenEvents = new Map<string, number>();
    /** How long to remember an event ID before evicting (ms). */
    const DEDUP_WINDOW_MS = 30_000;

    anySession._dispatchEvent = (event: { id?: string; type: string }) => {
      if (event.id) {
        const now = Date.now();

        // Drop duplicate — we've already dispatched this event
        if (seenEvents.has(event.id)) {
          return;
        }

        // Record this event ID
        seenEvents.set(event.id, now);

        // Evict stale entries to bound memory (lazy sweep)
        if (seenEvents.size > 500) {
          const cutoff = now - DEDUP_WINDOW_MS;
          for (const [id, ts] of seenEvents) {
            if (ts < cutoff) seenEvents.delete(id);
          }
        }
      }
      origDispatch(event);
    };
    anySession.__dedupPatched = true;
  }

  state.eventHandlerUnsub = session.on((event) => {
    // Stale handler guard — if another registerEventHandler call
    // has superseded us, bail immediately. This closes all possible
    // SDK-level handler duplication paths (session resume, infinite
    // sessions compaction, etc.) that could lead to doubled output.
    if (myGeneration !== state.handlerGeneration) {
      return;
    }

    // Log every event type in debug mode for diagnostics
    if (state.debugEnabled) {
      debugLog(
        `event: ${event.type} ${JSON.stringify(event.data ?? {}).slice(0, 200)}`,
      );
    }

    // Reset keep-alive timer on EVERY event — proves agent is alive
    resetKeepAliveTimer(deps);

    switch (event.type) {
      case "assistant.turn_start":
        // New turn — record start time and reset reasoning state.
        // Spinner-internal bookkeeping stays on the Spinner; the
        // visible state transition uses the UI port. Phase 4 will
        // absorb these direct spinner calls.
        spinner.resetTurnStart();
        spinner.clearReasoning();
        deps.ui.setActivity({ kind: "thinking", label: "Thinking..." });
        break;

      case "assistant.intent": {
        // Model declared an intent — show what it's planning.
        // Truncate long intents so the spinner line stays tidy.
        const MAX_INTENT_LEN = 30;
        const intent = (event.data as { intent?: string })?.intent ?? "";
        if (intent) {
          const truncated =
            intent.length > MAX_INTENT_LEN
              ? intent.slice(0, MAX_INTENT_LEN) + "…"
              : intent;
          // `setActivity` is idempotent — when the spinner is already
          // running it just updates the label (same behaviour as the
          // original `spinner.start(label)` call).
          deps.ui.setActivity({
            kind: "planning",
            label: `Planning: ${truncated}`,
          });
        }
        break;
      }

      case "assistant.reasoning_delta":
        // Model is actively reasoning — delegate to the UI port,
        // which routes to the existing shared renderer for the
        // terminal target.
        if (event.data?.deltaContent) {
          deps.ui.emitReasoning({ content: event.data.deltaContent });
        }
        break;

      case "assistant.message_delta": {
        // First delta kills the spinner — we have content flowing.
        // Capture reasoning length BEFORE emitText clears it.
        const hadReasoning = spinner.reasoningLength > 0;
        // Skip whitespace-only deltas before real content — the model
        // can emit "\n\n" before reasoning starts (undocumented).
        // Once real content has started, all deltas pass through.
        if (!state.streamedContent && event.data?.deltaContent?.trim() === "") {
          break;
        }
        // If verbose reasoning was scrolling, emit a visual
        // separator before the response text starts. The UI port
        // owns whether to actually emit bytes (no-op in compact mode).
        if (hadReasoning && !state.streamedContent) {
          deps.ui.emitReasoningTransition({});
        }
        // Stream response text token-by-token via the UI port.
        // TerminalUI suppresses streaming when markdown mode is on;
        // it always stops the spinner first so the eventual
        // `renderMarkdown` lands cleanly.
        if (event.data?.deltaContent) {
          deps.ui.emitText({ content: event.data.deltaContent });
          state.streamedContent = true;
          state.streamedText += event.data.deltaContent;
        }
        break;
      }

      case "assistant.message":
        // Capture the final message for sendAndWaitWithKeepAlive
        state.lastAssistantMessage = event as AssistantMessageEvent;
        if (state.debugEnabled && event.data?.content) {
          debugLog(`final message: ${event.data.content.slice(0, 200)}`);
        }
        break;

      case "session.idle":
        // Agent finished — clear status and resolve
        deps.ui.setActivity(null);
        if (state.pendingResolve) {
          const resolve = state.pendingResolve;
          clearKeepAliveState(deps);
          resolve(state.lastAssistantMessage);
        }
        break;

      case "abort":
        // User pressed ESC — session.abort() was called, SDK confirms.
        // Treat like session.idle: resolve the pending promise with
        // whatever partial content we captured.
        deps.ui.setActivity(null);
        if (state.pendingResolve) {
          const resolve = state.pendingResolve;
          clearKeepAliveState(deps);
          resolve(state.lastAssistantMessage);
        }
        break;

      case "session.error": {
        // Agent errored — clear status and reject
        deps.ui.setActivity(null);
        if (state.pendingReject) {
          const reject = state.pendingReject;
          clearKeepAliveState(deps);
          const data = event.data as { message: string; stack?: string };
          const error = new Error(data.message);
          if (data.stack) error.stack = data.stack;
          reject(error);
        }
        break;
      }

      case "tool.execution_start": {
        // Tool is executing — show which tool the LLM picked
        const toolName = event.data?.toolName ?? "unknown";
        const callId = event.data?.toolCallId;
        if (callId) pendingTools.set(callId, toolName);
        // The UI port owns the byte sequence: stop spinner, print
        // the tool line, restart spinner with " " label for
        // heartbeat visibility while the tool runs.
        deps.ui.emitToolStart({ name: toolName, callId: callId ?? "" });
        break;
      }

      case "tool.execution_complete": {
        const callId = event.data?.toolCallId;
        const toolName = callId
          ? (pendingTools.get(callId) ?? "unknown")
          : "unknown";
        if (callId) pendingTools.delete(callId);

        // ── Result-body gating ─────────────────────────────────────
        // Sandbox tools (execute_javascript / execute_bash) are the
        // LLM's primary work — `--verbose` is enough to see their
        // full output. Non-sandbox tools (plugin_info, module_info,
        // register_handler, suggest_approach, etc.) are protocol /
        // infrastructure with frequently-huge JSON payloads — gate
        // their bodies behind `--very-verbose` so plain `--verbose`
        // stays readable. Terse `✅ Done` / `❌ error` lines are
        // emitted for every tool in every mode, so the user always
        // sees that the tool completed.
        const isSandboxTool =
          toolName === "execute_javascript" || toolName === "execute_bash";
        const showFullBody =
          state.verboseOutput && (isSandboxTool || state.veryVerboseOutput);
        if (state.debugEnabled) {
          const status = event.data?.success ? "✅" : "❌";
          debugLog(`${status} ${toolName} complete`);
        }

        // ── Build a ToolResultPayload from the SDK event ───────
        // The branch tree below is intentionally cohesive: it
        // mirrors the original switch's content-driven decisions
        // (sandbox vs not, verbose vs not, parsed.error vs result,
        // string vs object vs primitive, markdown-eligible vs raw)
        // and assembles a single `ui.emitToolResult({...})` call
        // per outcome. The UI port owns the byte sequence
        // (icon line, body, hint, trailing blank, spinner restart).
        //
        // Gating: `showFullBody` is `state.verboseOutput && (isSandboxTool ||
        // state.veryVerboseOutput)` — sandbox tools (execute_javascript /
        // execute_bash) show full bodies under plain --verbose, but
        // protocol tools require --very-verbose to dump their bodies.
        const callIdStr = callId ?? "";
        if (event.data?.success) {
          const content = event.data?.result?.content ?? "";
          let parsed;
          try {
            parsed = JSON.parse(content);
          } catch {
            // Not JSON — that's fine
          }

          if (!showFullBody) {
            // ── Body suppressed: show errors, otherwise terse success ──
            if (parsed?.error && !parsed._userDisplayed) {
              deps.ui.emitToolResult({
                name: toolName,
                callId: callIdStr,
                status: "error",
                message: parsed.error,
                hint: buildBufferOverflowHint(parsed.error) ?? undefined,
              });
            } else {
              deps.ui.emitToolResult({
                name: toolName,
                callId: callIdStr,
                status: "success",
                message: "Done",
              });
            }
          } else if (parsed?.error) {
            // ── Verbose, errored ──
            if (parsed._userDisplayed) {
              // Tool handler already printed the clean error — emit
              // a silent result to trigger trailing housekeeping
              // (blank line + spinner restart) without re-display.
              deps.ui.emitToolResult({
                name: toolName,
                callId: callIdStr,
                status: "error",
                message: parsed.error,
                silent: true,
              });
            } else {
              deps.ui.emitToolResult({
                name: toolName,
                callId: callIdStr,
                status: "error",
                message: parsed.error,
                hint: buildBufferOverflowHint(parsed.error) ?? undefined,
              });
            }
          } else {
            // ── Verbose, successful — format the result body ──
            const resultValue = parsed?.result;
            const wasTruncated =
              typeof resultValue === "string" &&
              resultValue.endsWith("[TRUNCATED_FOR_LLM]");

            if (wasTruncated) {
              // Tool handler already displayed the full result; just
              // emit a silent result to drive the trailing housekeeping.
              deps.ui.emitToolResult({
                name: toolName,
                callId: callIdStr,
                status: "success",
                message: "",
                silent: true,
              });
            } else if (resultValue !== undefined) {
              let displayValue;
              try {
                displayValue = JSON.parse(resultValue);
              } catch {
                displayValue = resultValue;
              }

              const payload = buildVerboseResultPayload(
                toolName,
                callIdStr,
                displayValue,
                state.markdownEnabled,
              );
              deps.ui.emitToolResult(payload);
            } else if (content) {
              const preview =
                content.length > 300 ? content.slice(0, 300) + "…" : content;
              // Don't render truncated content as markdown — truncation
              // may break mid-token (code fence, table) producing garbled output.
              deps.ui.emitToolResult({
                name: toolName,
                callId: callIdStr,
                status: "success",
                message: `Result: ${preview}`,
              });
            } else {
              deps.ui.emitToolResult({
                name: toolName,
                callId: callIdStr,
                status: "success",
                message: "Tool complete",
              });
            }
          }
        } else {
          // ── Tool reported failure (event.data.success === false) ──
          // Check if the tool handler already displayed the error to
          // the user (indicated by _userDisplayed on the result).
          let alreadyDisplayed = false;
          try {
            const content = event.data?.result?.content;
            if (content) {
              const parsed = JSON.parse(content);
              alreadyDisplayed = !!parsed?._userDisplayed;
            }
          } catch {
            // Content isn't JSON or missing — that's fine
          }
          const errMsg = event.data?.error?.message ?? "unknown error";
          const errCode = event.data?.error?.code;
          if (alreadyDisplayed) {
            // Silent — handler showed it; just run trailing housekeeping.
            deps.ui.emitToolResult({
              name: toolName,
              callId: callIdStr,
              status: "error",
              message: errMsg,
              silent: true,
            });
          } else if (errCode === "denied") {
            deps.ui.emitToolResult({
              name: toolName,
              callId: callIdStr,
              status: "denied",
              message: "Tool denied by policy",
            });
          } else {
            deps.ui.emitToolResult({
              name: toolName,
              callId: callIdStr,
              status: "error",
              message: `Error: ${errMsg}`,
              hint: buildBufferOverflowHint(errMsg) ?? undefined,
            });
          }
        }
        // Note: `emitToolResult` already prints a trailing blank line
        // and restarts the spinner with "Thinking..." — the old
        // inline `console.log(); spinner.start("Thinking...")` block
        // is now owned by the UI port.
        break;
      }

      case "assistant.usage": {
        // Token usage stats — route through the UI port. The port's
        // `emitUsage` stops the spinner internally (matches the
        // original `spinner.stop()` to avoid ANSI cursor conflicts
        // with readline up-arrow history recall).
        const usageData = event.data as {
          model?: string;
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
          cost?: number;
          duration?: number;
        };

        // Accumulate session totals. Count one request per usage event;
        // usageData.cost is premium request count, not a reliable API-call counter.
        state.totalInputTokens += usageData.inputTokens ?? 0;
        state.totalOutputTokens += usageData.outputTokens ?? 0;
        state.totalCacheReadTokens += usageData.cacheReadTokens ?? 0;
        state.totalCacheWriteTokens += usageData.cacheWriteTokens ?? 0;
        state.totalRequests += 1;

        // Ensure stats appear on a new line — streamed message_delta
        // writes don't end with \n. Routed through the UI port so
        // alternative targets (e.g. JSON-lines) can decide whether a
        // separator is meaningful.
        if (state.streamedContent) {
          deps.ui.emitText({ content: "\n" });
        }
        // The port's payload uses `durationMs`; the SDK gives us
        // `duration` — translate at the boundary.
        deps.ui.emitUsage({
          model: usageData.model,
          inputTokens: usageData.inputTokens,
          outputTokens: usageData.outputTokens,
          cacheReadTokens: usageData.cacheReadTokens,
          cacheWriteTokens: usageData.cacheWriteTokens,
          cost: usageData.cost,
          durationMs: usageData.duration,
        });
        break;
      }

      case "tool.execution_progress": {
        // Tool progress update — update the spinner label via the UI
        // port. Phase 4 will consider whether a dedicated activity
        // payload (`kind: "tool"`) is a better fit; for now the
        // existing spinner-internal `updateLabel` call is preserved
        // verbatim via `setActivity`, which is byte-equivalent when
        // the spinner is already running.
        const progressMsg = (event.data as { progressMessage?: string })
          ?.progressMessage;
        if (progressMsg) {
          deps.ui.setActivity({ kind: "tool", label: progressMsg });
        }
        break;
      }

      case "tool.execution_partial_result": {
        // Partial tool output — log in debug mode for diagnostics.
        // Data: { toolCallId, partialOutput }
        if (state.debugEnabled) {
          const partial =
            (event.data as { partialOutput?: string })?.partialOutput ?? "";
          debugLog(`partial result: ${partial.slice(0, 200)}`);
        }
        break;
      }

      // ── SDK Events — P1: UX-critical signals ──────────────────
      // These events were previously unhandled. The SDK fires them
      // for session lifecycle visibility — ignoring them leaves the
      // user blind during compaction, truncation, and errors.

      case "session.warning": {
        // Warnings the SDK/CLI wants the user to see (rate limits,
        // approaching quota, etc.). Always surface these.
        const warnData = event.data as {
          warningType?: string;
          message?: string;
        };
        if (warnData.message) {
          deps.ui.emitNotification({
            level: "warning",
            kind: "sdk_warning",
            // Two-space gap after the icon for VGA alignment —
            // emitNotification adds one space, so we pre-pad with
            // the second.
            icon: "⚠️ ",
            message: warnData.message,
          });
        }
        break;
      }

      case "session.info": {
        // Informational messages from the SDK — surface dimmed so
        // they don't steal focus from the main conversation.
        const infoData = event.data as {
          infoType?: string;
          message?: string;
        };
        if (infoData.message) {
          // Suppress "Disabled tools:" message — it lists SDK built-ins
          // that we've whitelisted away via availableTools. Showing this
          // list confuses the model into thinking those are real
          // capabilities that are merely "turned off", leading to
          // hallucinated claims like "SQL-backed to-do lists".
          if (infoData.message.startsWith("Disabled tools:")) {
            if (state.debugEnabled) {
              debugLog(`Suppressed: ${infoData.message}`);
            }
            break;
          }
          deps.ui.emitNotification({
            level: "info",
            kind: "sdk_info",
            icon: "ℹ️ ",
            message: infoData.message,
          });
        }
        break;
      }

      case "session.compaction_start": {
        // Infinite sessions: context window is filling up, the SDK
        // is summarising old messages in the background.
        deps.ui.setActivity({
          kind: "compacting",
          label: "Compacting context…",
        });
        break;
      }

      case "session.compaction_complete": {
        // Compaction finished — show how much context was freed.
        const compData = event.data as {
          success?: boolean;
          error?: string;
          preCompactionTokens?: number;
          postCompactionTokens?: number;
          tokensRemoved?: number;
        };
        if (compData.success) {
          const pre = compData.preCompactionTokens ?? 0;
          const post = compData.postCompactionTokens ?? 0;
          const freed = compData.tokensRemoved ?? pre - post;
          deps.ui.emitNotification({
            level: "info",
            kind: "context_compacted",
            icon: "📦",
            message: `Context compacted: ${pre.toLocaleString()} → ${post.toLocaleString()} tokens (${freed.toLocaleString()} freed)`,
          });
        } else {
          deps.ui.emitNotification({
            level: "warning",
            kind: "context_compaction_failed",
            icon: "⚠️ ",
            message: `Context compaction failed: ${compData.error ?? "unknown error"}`,
          });
        }
        break;
      }

      case "session.truncation": {
        // Hard truncation — messages were evicted to stay within
        // token limits. More aggressive than compaction.
        const truncData = event.data as {
          tokenLimit?: number;
          tokensRemovedDuringTruncation?: number;
          messagesRemovedDuringTruncation?: number;
        };
        const tokensFreed = truncData.tokensRemovedDuringTruncation ?? 0;
        const msgsRemoved = truncData.messagesRemovedDuringTruncation ?? 0;
        deps.ui.emitNotification({
          level: "info",
          kind: "context_truncated",
          icon: "✂️ ",
          message: `Context truncated: ${msgsRemoved} messages, ${tokensFreed.toLocaleString()} tokens freed`,
        });
        break;
      }

      case "session.task_complete": {
        // The SDK signals that a logical task unit is done.
        // Surface the summary if present.
        const taskData = event.data as { summary?: string };
        if (taskData.summary) {
          deps.ui.emitNotification({
            level: "success",
            kind: "task_complete",
            icon: "✅",
            message: `Task complete: ${taskData.summary}`,
          });
        }
        break;
      }

      case "session.usage_info": {
        // Context window health — token utilisation snapshot.
        // Only show when utilisation exceeds 60% to avoid noise.
        const USAGE_VISIBILITY_THRESHOLD = 0.6;
        const HIGH_UTILISATION_THRESHOLD = 0.9;
        const usageData = event.data as {
          tokenLimit?: number;
          currentTokens?: number;
          messagesLength?: number;
        };
        const limit = usageData.tokenLimit ?? 0;
        const current = usageData.currentTokens ?? 0;
        if (limit > 0) {
          const pct = current / limit;
          if (pct >= USAGE_VISIBILITY_THRESHOLD) {
            const pctStr = (pct * 100).toFixed(0);
            const level =
              pct >= HIGH_UTILISATION_THRESHOLD ? "warning" : "info";
            deps.ui.emitNotification({
              level,
              kind: "context_usage",
              icon: "📊",
              message: `Context: ${current.toLocaleString()}/${limit.toLocaleString()} tokens (${pctStr}%)`,
            });
          }
        }
        break;
      }

      case "session.shutdown": {
        // End-of-session stats — premium requests, token totals,
        // code changes. Show a compact summary.
        const shutdownData = event.data as {
          totalPremiumRequests?: number;
          totalApiDurationMs?: number;
          codeChanges?: {
            linesAdded?: number;
            linesRemoved?: number;
            filesModified?: string[];
          };
        };
        const parts: string[] = [];
        if (shutdownData.totalPremiumRequests) {
          parts.push(`${shutdownData.totalPremiumRequests} API calls`);
        }
        if (shutdownData.totalApiDurationMs) {
          const secs = (shutdownData.totalApiDurationMs / 1000).toFixed(1);
          parts.push(`${secs}s total API time`);
        }
        if (shutdownData.codeChanges) {
          const cc = shutdownData.codeChanges;
          const added = cc.linesAdded ?? 0;
          const removed = cc.linesRemoved ?? 0;
          const files = cc.filesModified?.length ?? 0;
          if (added || removed || files) {
            parts.push(`+${added}/-${removed} lines in ${files} files`);
          }
        }
        if (parts.length > 0) {
          deps.ui.emitNotification({
            level: "info",
            kind: "session_stats",
            icon: "📈",
            message: `Session stats: ${parts.join(" · ")}`,
          });
        }
        break;
      }

      // ── P2 Events — Nice-to-have signals ─────────────────────

      case "session.model_change": {
        // Confirmation when session.setModel() or model switch
        // takes effect server-side.
        const modelData = event.data as {
          previousModel?: string;
          newModel?: string;
        };
        if (modelData.newModel) {
          deps.ui.emitNotification({
            level: "info",
            kind: "model_change",
            icon: "🔄",
            message: `Model: ${modelData.previousModel ?? "?"} → ${modelData.newModel}`,
          });
        }
        break;
      }

      case "session.resume": {
        // Session was resumed — show how many history events loaded.
        const resumeData = event.data as { eventCount?: number };
        if (resumeData.eventCount !== undefined) {
          deps.ui.emitNotification({
            level: "info",
            kind: "session_resume",
            icon: "⏮️ ",
            message: `Resumed with ${resumeData.eventCount} history events`,
          });
        }
        break;
      }

      case "session.title_changed": {
        // SDK auto-generates conversation titles. Set the terminal
        // title so tab/window management is easier.
        const titleData = event.data as { title?: string };
        if (titleData.title) {
          deps.ui.setWindowTitle({ title: titleData.title });
        }
        break;
      }

      // ── Debug-only events — log but don't display ────────────
      // These fire frequently during normal operation. Only
      // surface them when --debug is active.

      case "session.start":
      case "session.context_changed":
      case "session.mode_changed":
      case "session.plan_changed":
      case "session.snapshot_rewind":
      case "session.workspace_file_changed":
      case "session.handoff":
      case "assistant.turn_end":
      case "assistant.reasoning":
      case "assistant.streaming_delta":
      case "pending_messages.modified":
      case "system.message":
      case "skill.invoked":
      case "hook.start":
      case "hook.end":
      case "subagent.started":
      case "subagent.completed":
      case "subagent.failed":
      case "subagent.selected":
      case "subagent.deselected":
      case "tool.user_requested":
      case "user.message":
        // Handled by debug logging at the top of the handler
        break;
    }
  });
}

// ── REPL ─────────────────────────────────────────────────────────────
//
// A readline-based interactive loop. The agent streams responses token
// by token, with tool invocations shown inline.

// ── Keep-Alive sendAndWait ────────────────────────────────────────────
//
// The SDK's built-in sendAndWait() uses a FIXED absolute timeout —
// if set to 60s and the model chains 5 tool calls at 20s each, it
// fires mid-execution even though the agent is actively working.
//
// We use send() + the single consolidated event handler and shared
// module-level state (pendingResolve/pendingReject). The handler
// resets the INACTIVITY timer on every event, captures the final
// assistant message, and resolves/rejects the promise on idle/error.
//
// NO SECOND session.on() CALL — the single handler does it all.
//
// We don't need fixed timeouts.

/**
 * Send a message and wait for session.idle, with an INACTIVITY timeout
 * that resets every time any session event arrives.
 *
 * Uses the single consolidated handler registered by registerEventHandler —
 * no additional session.on() call, no second listener, no doubled output.
 *
 * @param session           — The active CopilotSession
 * @param prompt            — User message text
 * @param _inactivityMs     — Unused (timeout read from state.sendTimeoutOverride ?? SEND_TIMEOUT_MS)
  });
}

// ── Send and Wait ────────────────────────────────────────────────────

/**
 * Send a message and wait for session.idle, with keep-alive timeout.
 */
export function sendAndWaitWithKeepAlive(
  session: CopilotSession,
  prompt: string,
  deps: EventHandlerDeps,
): Promise<AssistantMessageEvent | undefined> {
  const { state } = deps;
  return new Promise<AssistantMessageEvent | undefined>((resolve, reject) => {
    state.lastAssistantMessage = undefined;
    state.pendingResolve = resolve;
    state.pendingReject = reject;
    resetKeepAliveTimer(deps);
    session.send({ prompt }).catch((err: unknown) => {
      clearKeepAliveState(deps);
      reject(err);
    });
  });
}
