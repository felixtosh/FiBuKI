/**
 * The numbers of the date window a File may be matched in (#613, #614). The
 * matcher applies them; the app's own description of matching prints them.
 * No imports, so the browser can read the same numbers.
 */

/** Days either side of a File's date a Transaction may be matched with. */
export const MATCH_WINDOW_DAYS = 30;

/**
 * Days past the File's Due Date or Debit Date (its anchor, the later of the
 * two) the window reaches forward (#614): the Debit Date's three-day
 * settlement lag plus a weekend or a slightly late payer.
 */
export const MATCH_WINDOW_ANCHOR_GRACE_DAYS = 7;

/**
 * An anchor more than this many days after the File's date is a misread (a
 * wrong year would open a window over a year wide) and does not stretch it.
 */
export const MATCH_WINDOW_MAX_ANCHOR_DAYS = 90;

/**
 * A printed instalment's due date more than this many days after the File's
 * date is a misread, like one more than MATCH_WINDOW_DAYS before it (#716):
 * it opens no window, and no payment's date is scored against it. A year
 * covers a twelve-month plan.
 */
export const MATCH_WINDOW_MAX_INSTALMENT_DAYS = 366;
