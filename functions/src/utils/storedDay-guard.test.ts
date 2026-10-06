/**
 * #673 — no host-zone date calls in the server.
 *
 * A stored date is UTC midnight of the Vienna calendar day. The host-zone
 * getters and setters, and the multi-argument `new Date(y, m, d)`, agree with
 * that only on a UTC host, so every one of them was a bug waiting for a
 * self-hoster to set the server's zone: Invoice due dates a day early across
 * a clock change, a BMD Export dated the day before, a New Year's Day Invoice
 * numbered into the old year. Stored days go through `utils/storedDay.ts`;
 * instants use `Date.now()` arithmetic or the explicit `getUTC*` calls. A
 * date formatted for a person names its `timeZone` (`viennaDateLabel`).
 *
 * The one exception is listed with its reason, and with how many calls it
 * holds, so a new call in the same file fails too.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const FUNCTIONS_SRC = join(__dirname, "..");

const ALLOWED: Record<string, { calls: number; reason: string }> = {
  "fileFacts/handCorrection.ts": {
    calls: 3,
    reason:
      "datesMatch also accepts the host-zone day, because a File dated before #666 on a " +
      "non-UTC host was stored at local midnight; dropping it would record a phantom Hand Correction",
  },
};

const HOST_ZONE_CALL =
  /\.(getDate|getDay|getMonth|getFullYear|getYear|getHours|getMinutes|getSeconds|getMilliseconds|getTimezoneOffset|setDate|setMonth|setFullYear|setYear|setHours|setMinutes|setSeconds|setMilliseconds)\s*\(/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" || name === "node_modules" ? [] : sourceFiles(path);
    return /\.ts$/.test(name) && !/\.(test|spec)\.ts$/.test(name) ? [path] : [];
  });
}

/** Comments name the forbidden calls to explain them; only code counts. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Index and argument text of each call `opener` starts, up to its closing parenthesis. */
function calls(code: string, opener: RegExp): Array<{ index: number; args: string; topLevelComma: boolean }> {
  const found: Array<{ index: number; args: string; topLevelComma: boolean }> = [];
  let match: RegExpExecArray | null;
  while ((match = opener.exec(code))) {
    const start = match.index + match[0].length;
    let depth = 1;
    let topLevelComma = false;
    let i = start;
    for (; i < code.length && depth > 0; i++) {
      const ch = code[i];
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
      else if (ch === "," && depth === 1) topLevelComma = true;
    }
    found.push({ index: match.index, args: code.slice(start, i - 1), topLevelComma });
  }
  return found;
}

/** Each `new Date(` whose arguments hold a top-level comma: a local-time constructor. */
function localConstructors(code: string): number[] {
  return calls(code, /\bnew\s+Date\s*\(/g)
    .filter((call) => call.topLevelComma)
    .map((call) => call.index);
}

/**
 * Each date formatted for display without a `timeZone`, which formats in the
 * host's zone. `toLocaleString` is left alone: here it only formats amounts.
 */
function unzonedFormats(code: string): number[] {
  return calls(code, /(\.toLocaleDateString|\.toLocaleTimeString|\bIntl\.DateTimeFormat)\s*\(/g)
    .filter((call) => !/\btimeZone\b/.test(call.args))
    .map((call) => call.index);
}

/** `line: code` for every host-zone date call in a source text. */
export function hostZoneCalls(source: string): string[] {
  const code = stripComments(source);
  const lineOf = (index: number) => code.slice(0, index).split("\n").length;
  const at = [...code.matchAll(HOST_ZONE_CALL)]
    .map((m) => m.index!)
    .concat(localConstructors(code), unzonedFormats(code));
  const lines = source.split("\n");
  return at.sort((a, b) => a - b).map((index) => `${lineOf(index)}: ${lines[lineOf(index) - 1].trim()}`);
}

describe("the guard's detector", () => {
  it("finds the host-zone getters and setters", () => {
    expect(hostZoneCalls("const y = d.getFullYear();\nd.setDate(d.getDate() + 1);")).toHaveLength(3);
  });

  it("finds the multi-argument constructor, even with calls in its arguments", () => {
    expect(hostZoneCalls("const end = new Date(now.getUTCFullYear(), 11, 31);")).toHaveLength(1);
  });

  it("finds a date formatted for display without a time zone", () => {
    const unzoned = [
      'const label = new Date().toLocaleDateString("de-AT");',
      "const t = d.toLocaleTimeString();",
      'const f = new Intl.DateTimeFormat("de-AT", { day: "2-digit" });',
    ].join("\n");
    expect(hostZoneCalls(unzoned)).toHaveLength(3);
  });

  it("lets the UTC forms, single-argument constructors and comments through", () => {
    const fine = [
      "const y = d.getUTCFullYear();",
      "const d = new Date(Date.UTC(year, 0, 1));",
      "const t = new Date(Date.now() + 7 * DAY_MS);",
      "const p = new Date(`${day}T00:00:00Z`);",
      "// written with new Date(y, m - 1, d) and read with getDate()",
      "/* d.setHours(23, 59, 59) */",
      'const label = d.toLocaleDateString("de-AT", { timeZone: "Europe/Vienna" });',
      'const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Vienna" });',
      'const amount = (cents / 100).toLocaleString("de-AT", { minimumFractionDigits: 2 });',
    ].join("\n");
    expect(hostZoneCalls(fine)).toEqual([]);
  });
});

describe("functions/src", () => {
  it("makes no host-zone date call outside the listed exceptions", () => {
    const offending: string[] = [];
    for (const path of sourceFiles(FUNCTIONS_SRC)) {
      const file = relative(FUNCTIONS_SRC, path).split("\\").join("/");
      const calls = hostZoneCalls(readFileSync(path, "utf8"));
      if (calls.length === 0) continue;
      if (ALLOWED[file]?.calls === calls.length) continue;
      offending.push(...calls.map((call) => `${file}:${call}`));
    }
    // A stored day goes through utils/storedDay.ts; an instant uses Date.now() or getUTC*.
    expect(offending).toEqual([]);
  });
});
