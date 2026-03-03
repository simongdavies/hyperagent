// ── Audit Progress ───────────────────────────────────────────────────
//
// Builds a progress callback for deepAudit() that prints phase-
// completion lines with icons and drives the spinner for streaming
// phases. Accepts a Spinner instance rather than closing over
// module-level spinner functions.
//
// ─────────────────────────────────────────────────────────────────────

import type { Spinner } from "./spinner.js";
import type { AuditProgressCallback } from "../plugin-system/auditor.js";
import {
  formatUsageStats,
  printUsageStats,
  renderReasoningDelta,
  renderReasoningTransition,
  printExtendedReasoningNotice,
  type UsageData,
} from "./llm-output.js";

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

/**
 * Build an audit progress callback that prints phase-completion lines
 * with icons and updates the spinner for streaming phases.
 *
 * Resets the spinner's turn-start timestamp on each major phase so the
 * elapsed counter tracks audit duration, not time since the last
 * conversation turn (which may be minutes or hours ago).
 *
 * @param spinner - The shared Spinner instance to drive.
 * @param verbose - Whether verbose output mode is enabled.
 * @returns `{ callback, getTracePath }` — the callback to pass to
 *   `deepAudit()`, and a getter for the trace file path captured
 *   during the `trace` phase.
 */
export function makeAuditProgressCallback(
  spinner: Spinner,
  verbose: boolean,
): {
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
      spinner.resetTurnStart();
      timerReset = true;
    }

    // ── REASONING phase events ───────────────────────────────
    if (phase === "reasoning" && detail) {
      if (currentPhase !== "responding") {
        // Transition PREPARING/THINKING → REASONING
        currentPhase = "reasoning";
        currentTurnHasReasoning = true;
        silentTurnCount = 0;
        renderReasoningDelta(spinner, detail, verbose);
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
          renderReasoningTransition(spinner, verbose, "     ");
        }
        currentPhase = "responding";
        spinner.stop();
        spinner.clearReasoning();
        console.log(`     📋 Receiving audit report...`);
        spinner.start(detail);
      } else {
        // Already responding — just update the label
        spinner.updateLabel(detail);
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
        spinner.stop();
        printExtendedReasoningNotice("     ");
      }

      // Only update spinner label if we're NOT already receiving
      // the response — don't overwrite "Receiving audit report..."
      if (currentPhase !== "responding") {
        spinner.start(`Analysis in progress (turn ${turnCount})...`);
      }
      return;
    }

    // ── USAGE-TICK events ────────────────────────────────────
    if (phase === "usage-tick" && detail) {
      // Only update spinner if not in responding phase
      if (currentPhase !== "responding") {
        spinner.start(detail);
      }
      return;
    }

    // ── USAGE (aggregated final stats) ───────────────────────
    if (phase === "usage" && detail) {
      try {
        const d = JSON.parse(detail) as UsageData;
        const statsStr = formatUsageStats(d);
        if (statsStr) {
          spinner.stop();
          printUsageStats(statsStr, "     ");
        }
      } catch {
        // Best-effort
      }
      return;
    }

    // ── All other phases (icons: static-scan, sanitize, etc.) ─
    const icon = AUDIT_PHASE_ICONS[phase];
    if (icon !== undefined && icon !== "") {
      spinner.stop();
      console.log(`     ${icon} ${detail ?? phase}`);
      spinner.start(detail ?? `Auditing...`);
    } else if (detail) {
      spinner.updateLabel(detail);
    }
  };

  return { callback, getTracePath: () => tracePath };
}
