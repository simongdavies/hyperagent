// ── Audit Progress ───────────────────────────────────────────────────
//
// Builds a progress callback for deepAudit() that drives the agent
// UI port (phase notifications, reasoning, activity labels, usage
// stats). All spinner-state mutations flow through the UI port —
// the audit pipeline holds no direct spinner reference.
//
// ─────────────────────────────────────────────────────────────────────

import type { AuditProgressCallback } from "../plugin-system/auditor.js";
import type { AgentUI } from "./ui/index.js";
import { type UsageData } from "./llm-output.js";

/** Phase → icon map for the audit progress pipeline display. */
const AUDIT_PHASE_ICONS: Record<string, string> = {
  "static-scan": "🔬",
  "static-scan-done": "✅",
  sanitize: "🧹",
  "sanitize-done": "✅",
  session: "🔌",
  "session-ready": "✅",
  prompt: "📤",
  reasoning: "", // spinner reasoning line, no log
  streaming: "", // spinner-only, no log line
  "usage-tick": "", // spinner-only, no log line
  turn: "", // spinner-only, CLI server continuation life sign
  parse: "📋",
};

/** Indent used for nested audit-progress lines (matches legacy output). */
const AUDIT_INDENT = "     ";

/**
 * Build an audit progress callback that emits phase-completion lines
 * and activity updates via the UI port.
 *
 * Resets the UI's turn-start timer on the first progress event so the
 * elapsed counter tracks audit duration, not time since the last
 * conversation turn (which may be minutes or hours ago).
 *
 * @param ui - The agent UI port for all user-visible emissions and
 *   spinner-state mutations.
 * @returns `{ callback, getTracePath }` — the callback to pass to
 *   `deepAudit()`, and a getter for the trace file path captured
 *   during the `trace` phase.
 */
export function makeAuditProgressCallback(ui: AgentUI): {
  callback: AuditProgressCallback;
  getTracePath: () => string;
} {
  let tracePath = "";
  let timerReset = false;

  // ── State Machine ──────────────────────────────────────────────
  // Track the audit display as a linear progression of phases.
  // Transitions:
  //
  //   PREPARING → THINKING ⇄ REASONING → RESPONDING
  //                  ↑            │
  //                  └────────────┘  (new turn)
  //
  // PREPARING: static scan, sanitization, session setup
  // THINKING:  turn started, waiting for model output
  // REASONING: reasoning_delta events flowing (visible or opaque)
  // RESPONDING: message_delta content arriving (the audit report)
  //
  // THINKING and REASONING can cycle (multi-turn), but once we
  // reach RESPONDING we stay there — no going back.
  type AuditPhase = "preparing" | "thinking" | "reasoning" | "responding";
  let currentPhase: AuditPhase = "preparing";

  /** Count of continuation turns for the spinner label. */
  let turnCount = 0;
  /** Whether we've shown the opaque reasoning notice. */
  let opaqueNoticeShown = false;
  /** Whether the current turn has produced any reasoning deltas. */
  let currentTurnHasReasoning = false;
  /** Count of consecutive turns with no reasoning output. */
  let silentTurnCount = 0;

  const callback: AuditProgressCallback = (phase, detail) => {
    if (phase === "trace" && detail) {
      tracePath = detail;
      return;
    }

    // Reset the elapsed timer once on the first progress event.
    if (!timerReset) {
      ui.beginTurn();
      timerReset = true;
    }

    // ── REASONING phase events ───────────────────────────────
    if (phase === "reasoning" && detail) {
      if (currentPhase !== "responding") {
        // Transition PREPARING/THINKING → REASONING
        currentPhase = "reasoning";
        currentTurnHasReasoning = true;
        silentTurnCount = 0;
        ui.emitReasoning({ content: detail });
      } else {
        // In RESPONDING — just track for opaque detection, no display
        currentTurnHasReasoning = true;
        silentTurnCount = 0;
      }
      return;
    }

    // ── STREAMING phase events (= response content arriving) ─
    if (phase === "streaming" && detail) {
      if (currentPhase !== "responding") {
        // Transition to RESPONDING — this is the audit report.
        // Show reasoning-complete banner if we were reasoning.
        if (currentPhase === "reasoning") {
          ui.emitReasoningTransition({
            showBanner: true,
            indent: AUDIT_INDENT,
            // Next activity is set below explicitly so the banner
            // method only handles the verbose terminator + line.
          });
        }
        currentPhase = "responding";
        ui.clearReasoningBuffer();
        ui.emitNotification({
          level: "plain",
          kind: "audit_receiving",
          icon: "📋",
          message: "Receiving audit report...",
          indent: AUDIT_INDENT,
        });
        ui.setActivity({ kind: "custom", label: detail });
      } else {
        // Already responding — just update the label
        ui.setActivity({ kind: "custom", label: detail });
      }
      return;
    }

    // ── TURN lifecycle events ────────────────────────────────
    if (phase === "turn") {
      turnCount++;

      // Track opaque reasoning (turns with no reasoning deltas)
      if (turnCount > 1 && !currentTurnHasReasoning) {
        silentTurnCount++;
      }
      currentTurnHasReasoning = false;

      // Show opaque notice after 2+ consecutive silent turns
      if (!opaqueNoticeShown && silentTurnCount >= 2) {
        opaqueNoticeShown = true;
        ui.emitNotification({
          level: "info",
          kind: "extended_reasoning",
          icon: "⏳",
          message:
            "Extended reasoning in progress (model is using opaque multi-step reasoning)",
          indent: AUDIT_INDENT,
        });
      }

      // Only update spinner label if we're NOT already receiving
      // the response — don't overwrite "Receiving audit report..."
      if (currentPhase !== "responding") {
        ui.setActivity({
          kind: "custom",
          label: `Analysis in progress (turn ${turnCount})...`,
        });
      }
      return;
    }

    // ── USAGE-TICK events ────────────────────────────────────
    if (phase === "usage-tick" && detail) {
      // Only update spinner if not in responding phase
      if (currentPhase !== "responding") {
        ui.setActivity({ kind: "custom", label: detail });
      }
      return;
    }

    // ── USAGE (aggregated final stats) ───────────────────────
    if (phase === "usage" && detail) {
      try {
        const d = JSON.parse(detail) as UsageData;
        ui.emitUsage({
          model: d.model,
          inputTokens: d.inputTokens,
          outputTokens: d.outputTokens,
          cacheReadTokens: d.cacheReadTokens,
          cacheWriteTokens: d.cacheWriteTokens,
          cost: d.cost,
          durationMs: d.duration,
          indent: AUDIT_INDENT,
        });
      } catch {
        // Best-effort
      }
      return;
    }

    // ── All other phases (icons: static-scan, sanitize, etc.) ─
    const icon = AUDIT_PHASE_ICONS[phase];
    if (icon !== undefined && icon !== "") {
      ui.emitNotification({
        level: "plain",
        kind: "audit_phase",
        icon,
        message: detail ?? phase,
        indent: AUDIT_INDENT,
      });
      ui.setActivity({
        kind: "custom",
        label: detail ?? `Auditing...`,
      });
    } else if (detail) {
      ui.setActivity({ kind: "custom", label: detail });
    }
  };

  return { callback, getTracePath: () => tracePath };
}
