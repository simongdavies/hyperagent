// ── agent/user-input-handler.ts — SDK onUserInputRequest hook ────────
//
// Enables the ask_user tool in the SDK — when the LLM needs a
// decision from the user, it calls this handler with a question
// and optional multiple-choice answers.
//
// This COMPLEMENTS the /command suggestion system, not replaces it:
//   - /commands  → config changes the LLM suggests (regex extraction)
//   - ask_user   → decisions the LLM needs (structured SDK tool)
//
// Phase 3a refactor (this file)
// ─────────────────────────────
// Readline ownership and modal-prompt rendering have moved into the
// `AgentUI.askChoice` / `AgentUI.askText` methods. This handler is
// now a thin shim that:
//   1. Short-circuits in `--auto-approve` mode (picks first choice
//      or "yes") — auto-approve is the **caller's** policy, not the
//      UI's, so it stays here. The "(auto: …)" affordance still
//      renders via `console.log` for now; Phase 2.6 will route it
//      through the UI's emit channel alongside other leaks.
//   2. Delegates to `ui.askChoice` (when `choices` are provided) or
//      `ui.askText` (otherwise).
//   3. Maps the UI's reply into the SDK's `UserInputResponse` shape.
// ─────────────────────────────────────────────────────────────────────

import { C } from "./ansi.js";
import type { AgentUI } from "./ui/index.js";

// ── Types ────────────────────────────────────────────────────────────
// Mirror the SDK's internal UserInputRequest/Response types which
// aren't re-exported from the public barrel (index.d.ts).

/** Request for user input from the agent (enables ask_user tool). */
interface UserInputRequest {
  /** The question to ask the user. */
  question: string;
  /** Optional choices for multiple choice questions. */
  choices?: string[];
  /** Whether to allow freeform text input in addition to choices. */
  allowFreeform?: boolean;
}

/** Response to a user input request. */
interface UserInputResponse {
  /** The user's answer. */
  answer: string;
  /** Whether the answer was freeform (not from choices). */
  wasFreeform: boolean;
}

/** Fallback when freeform input arrived empty — keeps the SDK happy. */
const NO_ANSWER_PROVIDED = "No answer provided";

/**
 * Create the onUserInputRequest handler.
 *
 * Uses a factory pattern so the handler can access the live `AgentUI`
 * and auto-approve flag without import cycles or global state. The
 * UI is the sole owner of readline now — Phase 3a moved that
 * responsibility off the handler.
 *
 * @param getUi — Callback returning the active AgentUI. Required at
 *   call time (returns "Unable to get user input" if absent —
 *   matches the previous "no readline" branch).
 * @param getAutoApprove — Callback returning the current
 *   auto-approve flag. Auto-approve short-circuits the prompt and
 *   picks the first choice (or "yes" for free-form).
 */
export function createUserInputHandler(
  getUi: () => AgentUI | null,
  getAutoApprove?: () => boolean,
): (request: UserInputRequest) => Promise<UserInputResponse> {
  return async (request: UserInputRequest): Promise<UserInputResponse> => {
    const { question, choices, allowFreeform } = request;
    const ui = getUi();
    const autoApprove = getAutoApprove?.() ?? false;

    // Safety: if the UI isn't wired up (shouldn't happen in normal
    // REPL flow), return a sensible default. Mirrors the previous
    // "readline missing" branch.
    if (!ui) {
      return { answer: "Unable to get user input", wasFreeform: true };
    }

    // In auto-approve mode, auto-select first choice or confirm.
    // The "(auto: …)" affordance flows through the UI port so the
    // `--no-color` strip and transcript listener cover it like every
    // other line, and JsonLinesUI (Phase 6) can route it as a
    // structured event instead of an opaque stdout write.
    if (autoApprove) {
      ui.setActivity(null);
      // Leading blank-line separator + 2-space-indent `❓ <question>`
      // line. Plain level preserves the `C.info` colour wrap on the
      // icon (LEVEL_COLOR[plain] is identity, so any inner SGR
      // survives byte-for-byte).
      ui.emitNotification({
        level: "plain",
        kind: "generic",
        indent: "",
        message: "",
      });
      ui.emitNotification({
        level: "plain",
        kind: "generic",
        icon: C.info("❓"),
        message: question,
      });
      if (choices && choices.length > 0) {
        ui.emitNotification({
          level: "plain",
          kind: "generic",
          indent: "     ",
          message: C.dim(`(auto: ${choices[0]})`),
        });
        return { answer: choices[0], wasFreeform: false };
      }
      ui.emitNotification({
        level: "plain",
        kind: "generic",
        indent: "     ",
        message: C.dim("(auto: yes)"),
      });
      return { answer: "yes", wasFreeform: true };
    }

    // ── Multiple choice ────────────────────────────────────────
    if (choices && choices.length > 0) {
      const { answer, wasFreeform } = await ui.askChoice({
        question,
        choices,
        // `undefined` / `true` → allow freeform (UI default).
        // Only `false` disables the freeform path explicitly.
        allowFreeform: allowFreeform !== false,
        kind: "ask_user",
      });
      return { answer, wasFreeform };
    }

    // ── Free-form question ─────────────────────────────────────
    const answer = await ui.askText({ question, kind: "ask_user" });
    return {
      answer: answer || NO_ANSWER_PROVIDED,
      wasFreeform: true,
    };
  };
}
