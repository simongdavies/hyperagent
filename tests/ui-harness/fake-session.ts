// ── tests/ui-harness/fake-session.ts ────────────────────────────────
//
// A tiny test double that satisfies the structural surface of a
// `CopilotSession` used by `registerEventHandler` (and the dedupe
// monkey-patch it applies).
//
// We pin down only what the handler touches:
//   - `on(handler) → unsubscribe`            (listener registration)
//   - `_dispatchEvent(event)`                (writable — dedupe wraps it)
//   - `__dedupPatched`                       (boolean flag set by handler)
//
// Test code drives the handler by calling `emit(event)`, which fans
// out via the (possibly-patched) `_dispatchEvent`.
//
// A fresh instance per test prevents state leaks (the dedupe patch
// is sticky once applied).
// ────────────────────────────────────────────────────────────────────

import type { CopilotSession, SessionEvent } from "@github/copilot-sdk";

/**
 * Listener callback shape. Matches what `session.on(handler)` expects.
 */
type SessionListener = (event: SessionEvent) => void;

/**
 * Minimal stand-in for a `CopilotSession`.
 *
 * Only the surface used by `registerEventHandler` is implemented;
 * everything else throws to fail loudly if a test accidentally
 * relies on real SDK behaviour.
 */
export class FakeSession {
  /** Registered listeners. Each `on()` appends; unsubscribe removes. */
  private readonly listeners: SessionListener[] = [];

  /**
   * Internal event dispatcher. Writable so the dedupe wrapper in
   * `registerEventHandler` can replace it (intentional design choice
   * in the production code).
   */
  // eslint-disable-next-line @typescript-eslint/naming-convention
  _dispatchEvent: (event: SessionEvent) => void = (event) => {
    for (const listener of this.listeners) listener(event);
  };

  /**
   * Sticky flag the production handler sets after monkey-patching
   * `_dispatchEvent`. Tests should construct a fresh `FakeSession`
   * each scenario to keep this reset.
   */
  // eslint-disable-next-line @typescript-eslint/naming-convention
  __dedupPatched?: boolean;

  /**
   * Register a listener. Returns an unsubscribe function with the
   * same semantics as `CopilotSession.on()`.
   */
  on(handler: SessionListener): () => void {
    this.listeners.push(handler);
    return () => {
      const i = this.listeners.indexOf(handler);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /**
   * Emit a single event through the (possibly-patched) dispatcher.
   *
   * Mirrors how the real SDK would deliver an event — going through
   * `_dispatchEvent` so the dedupe wrapper (if installed) gets a
   * chance to filter duplicates.
   */
  emit(event: SessionEvent): void {
    this._dispatchEvent(event);
  }

  /**
   * Emit a series of events in order.
   *
   * Errors thrown by listeners propagate to the caller so tests fail
   * loudly rather than silently swallowing handler bugs.
   */
  emitAll(events: SessionEvent[]): void {
    for (const event of events) this.emit(event);
  }

  /**
   * Coerce this stub to the SDK's `CopilotSession` type. The cast
   * goes through `unknown` to make it obvious at the call site that
   * we are deliberately bypassing the structural contract.
   */
  asSession(): CopilotSession {
    return this as unknown as CopilotSession;
  }
}
