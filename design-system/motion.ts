/**
 * Motion Design Tokens
 *
 * JS constants for programmatic use in React components
 * (e.g., setTimeout durations for cleaning up animation classes).
 * CSS classes reference the CSS custom properties in globals.css.
 */

/**
 * Check if a Firestore Timestamp or Date is within threshold of now.
 * Used to detect "just changed" state for one-shot animations
 * that survive virtual scroll unmount/remount.
 */
export function isRecentlyUpdated(updatedAt: unknown, thresholdMs: number): boolean {
  if (!updatedAt) return false;

  const val = updatedAt as any;
  const ts = typeof val.toMillis === "function"
    ? val.toMillis()
    : typeof val.toDate === "function"
    ? val.toDate().getTime()
    : val instanceof Date
    ? val.getTime()
    : null;
  if (ts === null) return false;
  return Date.now() - ts < thresholdMs;
}

export const MOTION = {
  /** Duration for the "just completed" glow effect */
  ROW_COMPLETE_DURATION_MS: 600,

  /** How long after updatedAt we consider a row "just completed" */
  JUST_COMPLETED_THRESHOLD_MS: 3000,

  /** Duration for counter bump animation */
  COUNTER_BUMP_DURATION_MS: 250,
} as const;
