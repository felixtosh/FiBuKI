/**
 * First setup's question (#805, ADR-0018): which fiscal years to track, open or
 * closed. The User picks per fiscal year; this turns the picks into the three
 * settings the server's one writer takes (updateFiscalYears), which checks them
 * again. The current fiscal year is always open.
 *
 * The picks always keep the order the stretches have, oldest first: untracked
 * years, then closed ones, then open ones up to the current year. Changing one
 * year moves the others it would otherwise contradict.
 */

export type YearStatus = "untracked" | "closed" | "open";

export interface SetupYear {
  /** `2024`, or `2024/25` for a fiscal year that does not start in January. */
  label: string;
  /** Its first month, `YYYY-MM`. */
  start: string;
}

export interface FirstSetupSettings {
  startMonth: number;
  trackedFrom: string;
  closedThrough: string | null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Today in Vienna, `YYYY-MM-DD`: the calendar FiBuKI's dates are in. */
export function viennaToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Vienna" }).format(now);
}

/** The fiscal years to offer, the current one first, then `count - 1` earlier ones. */
export function setupYears(today: string, startMonth: number, count = 5): SetupYear[] {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const currentStart = month >= startMonth ? year : year - 1;
  return Array.from({ length: count }, (_, i) => {
    const y = currentStart - i;
    return {
      label: startMonth === 1 ? String(y) : `${y}/${pad((y + 1) % 100)}`,
      start: `${y}-${pad(startMonth)}`,
    };
  });
}

/** The default: the current fiscal year open, every earlier one untracked. */
export function defaultStatuses(count: number): YearStatus[] {
  return Array.from({ length: count }, (_, i) => (i === 0 ? "open" : "untracked"));
}

/**
 * Set one year's status (index 0 is the current year, which stays open) and
 * move the others so the order holds: an untracked year leaves every earlier
 * one untracked; a closed year closes every earlier tracked one and tracks
 * every later untracked one as closed; an open year opens every later one.
 */
export function setYearStatus(statuses: YearStatus[], index: number, status: YearStatus): YearStatus[] {
  if (index === 0) return statuses;
  return statuses.map((current, i) => {
    if (i === index) return status;
    const earlier = i > index;
    if (status === "untracked") return earlier ? "untracked" : current;
    if (status === "closed") {
      if (earlier) return current === "untracked" ? current : "closed";
      return current === "untracked" ? "closed" : current;
    }
    return earlier ? current : "open";
  });
}

/** The month before `month`, `YYYY-MM`. */
function monthBefore(month: string): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}

/** The settings these picks mean: Tracked From at the oldest tracked year, Closed Through before the oldest open one. */
export function settingsFromStatuses(years: SetupYear[], statuses: YearStatus[], startMonth: number): FirstSetupSettings {
  let trackedFrom = years[0].start;
  let oldestOpen = years[0].start;
  let anyClosed = false;
  statuses.forEach((status, i) => {
    if (status !== "untracked") trackedFrom = years[i].start;
    if (status === "open") oldestOpen = years[i].start;
    if (status === "closed") anyClosed = true;
  });
  return { startMonth, trackedFrom, closedThrough: anyClosed ? monthBefore(oldestOpen) : null };
}
