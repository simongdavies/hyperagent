// ── Fuzzy Matching ───────────────────────────────────────────────────
//
// Levenshtein distance for typo correction on slash subcommands.
// Pure functions — no external dependencies.
//
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute the Levenshtein edit distance between two strings.
 * Used to suggest corrections for mistyped subcommands.
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  // dp[j] = distance between a[0..i-1] and b[0..j-1]
  const dp = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] =
        a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

/**
 * Find the closest match to `input` from `candidates`.
 * Returns the best match if the edit distance is <= maxDist,
 * or null if nothing is close enough.
 */
export function closestMatch(
  input: string,
  candidates: readonly string[],
  maxDist = 3,
): string | null {
  let best: string | null = null;
  let bestDist = maxDist + 1;
  for (const c of candidates) {
    const d = levenshtein(input, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}
