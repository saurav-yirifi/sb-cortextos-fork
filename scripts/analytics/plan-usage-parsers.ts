/**
 * scripts/analytics/plan-usage-parsers.ts
 *
 * Pure-function helpers extracted from plan-usage-snapshot.ts so they can
 * be unit-tested without standing up a real Chrome / puppeteer-core stack.
 *
 * No imports, no I/O — keep it that way. Anything DOM-shaped or process-
 * shaped belongs in the main snapshot script.
 */

/**
 * Parse the rendered text of a "%-style" DOM element into a number.
 *
 * Handles the shapes Anthropic's dashboard is observed to use (or likely
 * to use, pending live verification):
 *   - "47%"          → 47
 *   - "47.3 %"       → 47.3
 *   - "0%"           → 0
 *   - "  72%  "      → 72
 *
 * Returns null when the input has no numeric prefix at all (callers
 * decide whether null is recoverable or a parse_error).
 */
export function parsePercent(s: string): number | null {
  const m = s.match(/(\d+(?:\.\d+)?)\s*%?/);
  if (!m) return null;
  return Number(m[1]);
}
