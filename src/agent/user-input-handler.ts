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
// ─────────────────────────────────────────────────────────────────────

import type { Interface as ReadlineInterface } from "node:readline/promises";
import { C } from "./ansi.js";

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

/**
 * Create the onUserInputRequest handler.
 *
 * Uses a factory pattern so the handler can access the active
 * readline instance without import cycles or global state.
 *
 * @param getRl — Callback returning the active readline instance
 * @param getSpinner — Callback returning the Spinner instance (to stop it during input)
 */
export function createUserInputHandler(
  getRl: () => ReadlineInterface | null,
  getSpinner?: () => {
    stop: () => void;
    start: (label?: string) => void;
  } | null,
  getAutoApprove?: () => boolean,
): (request: UserInputRequest) => Promise<UserInputResponse> {
  return async (request: UserInputRequest): Promise<UserInputResponse> => {
    const { question, choices, allowFreeform } = request;
    const rl = getRl();
    const spin = getSpinner?.();
    const autoApprove = getAutoApprove?.() ?? false;

    // Safety: if readline isn't available (shouldn't happen in
    // normal REPL flow), return a sensible default.
    if (!rl) {
      return { answer: "Unable to get user input", wasFreeform: true };
    }

    // In auto-approve mode, auto-select first choice or confirm
    if (autoApprove) {
      spin?.stop();
      console.log(`\n  ${C.info("❓")} ${question}`);
      if (choices && choices.length > 0) {
        console.log(`     ${C.dim(`(auto: ${choices[0]})`)}`);
        return { answer: choices[0], wasFreeform: false };
      }
      console.log(`     ${C.dim("(auto: yes)")}`);
      return { answer: "yes", wasFreeform: true };
    }

    // Stop the spinner so it doesn't overwrite the readline prompt
    spin?.stop();

    // ── Multiple choice ────────────────────────────────────────
    if (choices && choices.length > 0) {
      console.log(`\n  ${C.info("❓")} ${question}`);
      for (let i = 0; i < choices.length; i++) {
        console.log(`     ${C.info(`[${i + 1}]`)} ${choices[i]}`);
      }
      if (allowFreeform !== false) {
        console.log(`     ${C.dim("Or type a custom answer")}`);
      }
      const answer = await rl.question(`     ${C.dim("Choice: ")}`);
      const trimmed = answer.trim();
      const pick = parseInt(trimmed, 10);

      // Valid numbered choice
      if (pick >= 1 && pick <= choices.length) {
        return { answer: choices[pick - 1], wasFreeform: false };
      }

      // Freeform fallback (if allowed, or if they typed something invalid)
      if (trimmed) {
        return { answer: trimmed, wasFreeform: true };
      }

      // Empty input → first choice as default
      return { answer: choices[0], wasFreeform: false };
    }

    // ── Free-form question ─────────────────────────────────────
    console.log(`\n  ${C.info("❓")} ${question}`);
    const answer = await rl.question(`     ${C.dim("> ")}`);
    return { answer: answer.trim() || "No answer provided", wasFreeform: true };
  };
}
