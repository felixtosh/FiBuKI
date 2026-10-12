/**
 * What the chat model is told about the moment, beside the static prompt:
 * today's date in Vienna and the page the User has open, with the record
 * selected on it. A model that has to guess "today" or "this transaction"
 * guesses wrong, and a weaker model guesses wrong more often.
 *
 * The page comes from the browser, so it is shape-checked here and only ever
 * named to the model; every tool still checks that a record is the User's.
 */

export interface PageContext {
  path: string;
  /** The `?id=` of a list page: the Transaction, File or Partner open in its detail panel. */
  selectedId?: string;
}

const KIND_BY_PATH: Array<[RegExp, string]> = [
  [/^\/transactions(\/|$)/, "transaction"],
  [/^\/files(\/|$)/, "file"],
  [/^\/partners(\/|$)/, "partner"],
];

/** The `page` field of a chat request, or null when it is absent or malformed. */
export function parsePageContext(raw: unknown): PageContext | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.path !== "string" || !/^\/[\w\-/]{0,120}$/.test(r.path)) return null;
  const selectedId =
    typeof r.selectedId === "string" && /^[\w-]{1,128}$/.test(r.selectedId) ? r.selectedId : undefined;
  return { path: r.path, ...(selectedId ? { selectedId } : {}) };
}

/** Today's calendar day in Vienna, as YYYY-MM-DD plus the weekday. */
export function viennaToday(now: Date): { date: string; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vienna",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, weekday: get("weekday") };
}

/** The context block appended to the system prompt. */
export function buildContextBlock(input: { now: Date; page?: PageContext | null }): string {
  const { date, weekday } = viennaToday(input.now);
  const lines = [
    "## Right now",
    `- Today is ${weekday}, ${date} (Europe/Vienna). Resolve "last month", "Q3", "this year" from this date.`,
  ];
  const page = input.page;
  if (page) {
    const kind = KIND_BY_PATH.find(([re]) => re.test(page.path))?.[1];
    if (kind && page.selectedId) {
      lines.push(
        `- The user has the ${page.path} page open with ${kind} ${page.selectedId} selected. ` +
          `"This ${kind}", "this one" or "here" means ${kind} ${page.selectedId}: use that id.`
      );
    } else {
      lines.push(`- The user has the ${page.path} page open, with nothing selected.`);
    }
  }
  return lines.join("\n");
}
