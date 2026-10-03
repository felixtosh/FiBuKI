/**
 * Ordering and narrowing the candidate list in the two connect windows: the
 * one that finds a Transaction for a File (#244) and its mirror that finds a
 * File for a Transaction (#555). The reference date is the File's date in the
 * first and the Transaction's in the second; a candidate's date is a
 * Transaction's booking date or a File's extracted date.
 *
 * Two registers, deliberately: the mechanism is **proximity** (the word the
 * scorers already use), the label the user reads is "Closest".
 *
 * Nothing here scores. "Best match" is the server's match confidence, passed
 * in as it came back from the scorer; the other orders are plain date orders.
 * Filtering is client-side over the candidates already loaded: the query the
 * overlay issues does not change.
 *
 * There is deliberately no amount filter. It would hide exactly the split
 * part-invoice and Remainder cases this overlay exists to serve. Amount will be
 * a sort key only ("Closest amount"), and only once a typed amount can be
 * parsed at all (#183).
 */

export type ConnectSortMode = "best" | "closest-date" | "newest";

export const CONNECT_SORT_OPTIONS: Array<{ value: ConnectSortMode; label: string }> = [
  { value: "best", label: "Best match" },
  { value: "closest-date", label: "Closest date" },
  { value: "newest", label: "Newest" },
];

/** ± days around the reference date; null is "all". */
export type ConnectDateWindow = 7 | 30 | null;

export const CONNECT_DATE_WINDOW_OPTIONS: Array<{ value: ConnectDateWindow; label: string }> = [
  { value: 7, label: "±7 days" },
  { value: 30, label: "±30 days" },
  { value: null, label: "All dates" },
];

export interface ConnectCandidate {
  id: string;
  /**
   * Milliseconds since epoch. Null for a File with no extracted date, which
   * no date filter hides and every date order puts last (#555).
   */
  dateMs: number | null;
  partnerId?: string | null;
}

export interface ConnectFilters {
  /** Keep only candidates assigned to this Partner. Null or absent: off. */
  partnerId?: string | null;
  /** ± days around `referenceDateMs`. Null or absent: all. */
  dateWindowDays?: ConnectDateWindow;
  /** The date the window is around; without one it cannot apply. */
  referenceDateMs?: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function filterConnectCandidates<T extends ConnectCandidate>(
  candidates: readonly T[],
  { partnerId, dateWindowDays, referenceDateMs }: ConnectFilters
): T[] {
  return candidates.filter((c) => {
    if (partnerId && c.partnerId !== partnerId) return false;
    // An undated candidate is never hidden by a date window: an unextracted
    // document must not silently vanish.
    if (dateWindowDays != null && referenceDateMs != null && c.dateMs != null) {
      if (Math.abs(c.dateMs - referenceDateMs) > dateWindowDays * DAY_MS) return false;
    }
    return true;
  });
}

/**
 * Order the candidates. `confidenceOf` is the server's match confidence for a
 * candidate, or undefined where the scorer returned no Match for it.
 *
 * - best: scored candidates first by confidence, the rest newest first. This
 *   is exactly the order the overlay had before there was a choice.
 * - closest-date: smallest distance from the reference date, in either
 *   direction. Not the same as newest: a March reference puts March first, not
 *   today. Without a reference date there is nothing to be close to, so it
 *   reads as newest.
 * - newest: date descending.
 *
 * An undated candidate sorts after every dated one in each date order.
 */
export function sortConnectCandidates<T extends ConnectCandidate>(
  candidates: readonly T[],
  mode: ConnectSortMode,
  opts: {
    confidenceOf: (candidate: T) => number | undefined;
    referenceDateMs?: number | null;
  }
): T[] {
  const undatedLast = (a: T, b: T) => (a.dateMs == null ? 1 : 0) - (b.dateMs == null ? 1 : 0);
  const newest = (a: T, b: T) => undatedLast(a, b) || (b.dateMs ?? 0) - (a.dateMs ?? 0);
  const sorted = [...candidates];

  if (mode === "best") {
    return sorted.sort((a, b) => {
      const ca = opts.confidenceOf(a);
      const cb = opts.confidenceOf(b);
      if (ca !== undefined && cb !== undefined) return cb - ca;
      if (ca !== undefined) return -1;
      if (cb !== undefined) return 1;
      return newest(a, b);
    });
  }

  if (mode === "closest-date" && opts.referenceDateMs != null) {
    const reference = opts.referenceDateMs;
    return sorted.sort((a, b) => {
      if (a.dateMs == null || b.dateMs == null) return newest(a, b);
      const proximity = Math.abs(a.dateMs - reference) - Math.abs(b.dateMs - reference);
      return proximity !== 0 ? proximity : newest(a, b);
    });
  }

  return sorted.sort(newest);
}

/**
 * The overlay's sort and chips, remembered while the app is open and gone on
 * reload (#244). Deliberately not persisted per user: a sort set three weeks
 * ago and forgotten is a silent wrong-order bug, and the scorer's order is
 * where the user should land by default.
 *
 * Remembered per window, by what it lists (#555): the Files-side window lists
 * Transactions, the Transaction-side one Files, and neither overwrites the
 * other's choice.
 */
export type ConnectWindowList = "transactions" | "files";

export interface ConnectControls {
  sort: ConnectSortMode;
  partnerOnly: boolean;
  dateWindowDays: ConnectDateWindow;
}

export const DEFAULT_CONNECT_CONTROLS: ConnectControls = {
  sort: "best",
  partnerOnly: false,
  dateWindowDays: null,
};

const remembered: Record<ConnectWindowList, ConnectControls> = {
  transactions: { ...DEFAULT_CONNECT_CONTROLS },
  files: { ...DEFAULT_CONNECT_CONTROLS },
};

export function rememberedConnectControls(
  list: ConnectWindowList = "transactions"
): ConnectControls {
  return { ...remembered[list] };
}

export function rememberConnectControls(
  controls: ConnectControls,
  list: ConnectWindowList = "transactions"
): void {
  remembered[list] = { ...controls };
}

/**
 * What the Files tab says about the search box (#598). One box serves every
 * tab, but only typed text narrows the Files tab (#555): the auto-search and
 * the suggestion chips are mailbox searches. When the box shows other text
 * than the one narrowing the Files tab, the tab says so. Null: nothing to say.
 */
export type FilesSearchNotice =
  | { kind: "notApplied"; boxQuery: string }
  | { kind: "narrowedBy"; boxQuery: string; filesQuery: string };

export function filesSearchNotice(
  boxQuery: string,
  filesQuery: string
): FilesSearchNotice | null {
  const box = boxQuery.trim();
  const files = filesQuery.trim();
  if (!box || box === files) return null;
  if (!files) return { kind: "notApplied", boxQuery: box };
  return { kind: "narrowedBy", boxQuery: box, filesQuery: files };
}
