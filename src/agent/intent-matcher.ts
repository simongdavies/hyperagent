// ── agent/intent-matcher.ts — Keyword-based intent matching ─────────
//
// Matches user intent text against skill triggers to find the best
// skill(s) for the request. Used as the first stage of suggest_approach.
//
// ─────────────────────────────────────────────────────────────────────

import type { Skill } from "./skill-loader.js";

// ── Types ────────────────────────────────────────────────────────────

/** A matched skill with its score. */
export interface SkillMatch {
  /** Skill name. */
  name: string;
  /** Number of trigger words that matched. */
  score: number;
  /** Which trigger words matched. */
  matchedTriggers: string[];
}

// ── Implementation ──────────────────────────────────────────────────

/**
 * Tokenise intent text into lowercase words.
 * Strips punctuation and splits on whitespace.
 */
function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/**
 * Match user intent against skill triggers.
 * Returns skills ranked by number of matching trigger words (descending).
 * Only skills with at least 1 matching trigger are returned.
 *
 * @param intent - User's request in natural language
 * @param skills - Map of skill name → Skill (from loadSkills)
 * @returns Matched skills sorted by score (highest first)
 */
export function matchIntent(
  intent: string,
  skills: Map<string, Skill>,
): SkillMatch[] {
  const words = tokenise(intent);
  const matches: SkillMatch[] = [];

  for (const [name, skill] of skills) {
    if (skill.triggers.length === 0) continue;

    const matchedTriggers: string[] = [];

    for (const trigger of skill.triggers) {
      const triggerLower = trigger.toLowerCase();
      // Check if any word matches the trigger, or if the trigger
      // appears as a substring in the intent (for multi-word triggers)
      if (
        words.includes(triggerLower) ||
        intent.toLowerCase().includes(triggerLower)
      ) {
        matchedTriggers.push(trigger);
      }
    }

    if (matchedTriggers.length > 0) {
      matches.push({
        name,
        score: matchedTriggers.length,
        matchedTriggers,
      });
    }
  }

  // Sort by score descending, then by name for stability
  matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return matches;
}
