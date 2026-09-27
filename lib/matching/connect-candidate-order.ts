/**
 * Ordering and narrowing the Transaction list in the overlay that finds a
 * Transaction for a File (#244).
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

/** ± days around the File's date; null is "all". */
export type ConnectDateWindow = 7 | 30 | null;

export const CONNECT_DATE_WINDOW_OPTIONS: Array<{ value: ConnectDateWindow; label: string }> = [
  { value: 7, label: "±7 days" },
  { value: 30, label: "±30 days" },
  { value: null, label: "All dates" },
];

export interface ConnectCandidate {
  id: string;
  /** Milliseconds since epoch. */
  dateMs: number;
  partnerId?: string | null;
}

export interface ConnectFilters {
  /** Keep only Transactions assigned to this Partner. Null or absent: off. */
  partnerId?: string | null;
  /** ± days around `fileDateMs`. Null or absent: all. */
  dateWindowDays?: ConnectDateWindow;
  /** The File's extracted date; without one the date window cannot apply. */
  fileDateMs?: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function filterConnectCandidates<T extends ConnectCandidate>(
  candidates: readonly T[],
  { partnerId, dateWindowDays, fileDateMs }: ConnectFilters
): T[] {
  return candidates.filter((c) => {
    if (partnerId && c.partnerId !== partnerId) return false;
    if (dateWindowDays != null && fileDateMs != null) {
      if (Math.abs(c.dateMs - fileDateMs) > dateWindowDays * DAY_MS) return false;
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
 * - closest-date: smallest distance from the File's date, in either direction.
 *   Not the same as newest: a File from March puts March first, not today.
 *   Without a File date there is nothing to be close to, so it reads as newest.
 * - newest: date descending.
 */
export function sortConnectCandidates<T extends ConnectCandidate>(
  candidates: readonly T[],
  mode: ConnectSortMode,
  opts: {
    confidenceOf: (candidate: T) => number | undefined;
    fileDateMs?: number | null;
  }
): T[] {
  const newest = (a: T, b: T) => b.dateMs - a.dateMs;
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

  if (mode === "closest-date" && opts.fileDateMs != null) {
    const fileDateMs = opts.fileDateMs;
    return sorted.sort((a, b) => {
      const proximity =
        Math.abs(a.dateMs - fileDateMs) - Math.abs(b.dateMs - fileDateMs);
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
 */
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

let remembered: ConnectControls = { ...DEFAULT_CONNECT_CONTROLS };

export function rememberedConnectControls(): ConnectControls {
  return { ...remembered };
}

export function rememberConnectControls(controls: ConnectControls): void {
  remembered = { ...controls };
}
