// ── tests/ui-harness/event-factory.ts ────────────────────────────────
//
// Tiny constructors for `SessionEvent` values used by golden tests.
//
// The SDK's `SessionEvent` is a strict discriminated union: every
// variant requires `id`, `parentId`, `timestamp`, `data`, and `type`.
// We don't care about those scaffolding fields in the goldens — they
// never reach stdout — but they must be present to satisfy the type.
//
// Each `mk*` helper:
//   - generates a deterministic `id` from a monotonic counter (so
//     re-running the same script produces the same dedupe keys and
//     therefore the same output);
//   - sets `timestamp` to a fixed ISO value (Y2K, easy to spot);
//   - sets `parentId` to `null` (event-handler doesn't read it).
//
// Casting through `as unknown as SessionEvent` is intentional — we
// only need enough surface to satisfy the handler's switch statement,
// not the full generated shape.
// ────────────────────────────────────────────────────────────────────

import type { SessionEvent } from "@github/copilot-sdk";

/**
 * Fixed timestamp for all synthetic events. Never reaches the
 * captured output (the handler ignores `event.timestamp`), but the
 * SDK type insists on a value, so we provide one.
 */
const TEST_TIMESTAMP = "2000-01-01T00:00:00.000Z";

/**
 * Monotonic counter for deterministic event IDs.
 *
 * `make()` resets it via the closure so each test gets a fresh
 * sequence. Kept at module scope here intentionally — the factory
 * returned by `make()` owns its own counter.
 */
function newCounter(): () => string {
  let n = 0;
  return () => `evt-${++n}`;
}

/**
 * Make a fresh suite of event constructors. Each returned object has
 * a private monotonic counter for IDs.
 *
 * Tests typically call this at the top of their `it` block:
 *
 * ```ts
 * const e = makeEventFactory();
 * const events = [
 *   e.turnStart("turn-1"),
 *   e.messageDelta("Hello "),
 *   e.messageDelta("world!"),
 *   e.idle(),
 * ];
 * ```
 */
export function makeEventFactory() {
  const nextId = newCounter();

  /**
   * Wrap a partial event object into a fully-formed SessionEvent
   * by stamping the scaffolding fields the handler doesn't read.
   */
  function wrap<T extends { type: string; data?: unknown }>(
    payload: T,
  ): SessionEvent {
    return {
      id: nextId(),
      parentId: null,
      timestamp: TEST_TIMESTAMP,
      ...payload,
    } as unknown as SessionEvent;
  }

  return {
    turnStart(turnId = "turn-1"): SessionEvent {
      return wrap({ type: "assistant.turn_start", data: { turnId } });
    },

    /**
     * Streaming text delta. Multiple of these accumulate into one
     * full assistant message.
     */
    messageDelta(deltaContent: string, messageId = "msg-1"): SessionEvent {
      return wrap({
        type: "assistant.message_delta",
        data: { deltaContent, messageId },
      });
    },

    /**
     * Final assistant message — captured by event handler into
     * `state.lastAssistantMessage` for the `send`-and-wait promise.
     */
    message(content: string, messageId = "msg-1"): SessionEvent {
      return wrap({
        type: "assistant.message",
        data: { content, messageId, role: "assistant" },
      });
    },

    /**
     * Session reached idle — resolves the pending promise and stops
     * the spinner. Most test scripts should end with this.
     */
    idle(): SessionEvent {
      return wrap({ type: "session.idle", data: {} });
    },

    /**
     * Reasoning delta — model is "thinking aloud" before producing
     * the final answer.
     */
    reasoningDelta(deltaContent: string): SessionEvent {
      return wrap({
        type: "assistant.reasoning_delta",
        data: { deltaContent },
      });
    },

    /**
     * Tool execution starting — surfaces a "🔧 toolName" line.
     */
    toolStart(toolName: string, toolCallId: string): SessionEvent {
      return wrap({
        type: "tool.execution_start",
        data: { toolName, toolCallId, args: {} },
      });
    },

    /**
     * Successful tool execution — sandbox tools print "✅ Result: ..."
     */
    toolCompleteOk(
      toolCallId: string,
      result: { content: string },
    ): SessionEvent {
      return wrap({
        type: "tool.execution_complete",
        data: { toolCallId, success: true, result },
      });
    },

    /**
     * Failed tool execution — prints "❌ Error: ..." or
     * "🚫 Tool denied by policy" if `error.code === "denied"`.
     */
    toolCompleteErr(
      toolCallId: string,
      error: { message: string; code?: string },
    ): SessionEvent {
      return wrap({
        type: "tool.execution_complete",
        data: { toolCallId, success: false, error },
      });
    },

    /**
     * Usage stats — emitted by the SDK after each API call. Includes
     * input/output/cache tokens and cost.
     */
    usage(data: {
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      cost?: number;
      duration?: number;
    }): SessionEvent {
      return wrap({ type: "assistant.usage", data });
    },

    /**
     * SDK warning surfaced to the user.
     */
    warning(message: string, warningType = "generic"): SessionEvent {
      return wrap({
        type: "session.warning",
        data: { message, warningType },
      });
    },

    /**
     * Session error — rejects the pending promise.
     */
    error(message: string, stack?: string): SessionEvent {
      return wrap({ type: "session.error", data: { message, stack } });
    },
  };
}

export type EventFactory = ReturnType<typeof makeEventFactory>;
