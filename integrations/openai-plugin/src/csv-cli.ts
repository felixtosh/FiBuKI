/**
 * fibuki-csv: turn a bank CSV into FiBuKI transactions, and optionally import them.
 *
 * Bundled into scripts/fibuki-csv.mjs (npm run build in this folder). The parsing
 * is FiBuKI's own lib/import code, so the plugin never does money or date
 * arithmetic itself and cannot drift from what the web import accepts.
 *
 *   fibuki-csv analyze <file> [--skip N]
 *   fibuki-csv convert <file> --date COL (--amount COL | --debit COL --credit COL) --name COL
 *              [--description COL] [--partner COL] [--reference COL] [--iban COL]
 *              [--currency EUR | --currency-col COL] [--date-format ID] [--amount-format ID]
 *              [--balance COL] [--skip N] [--after YYYY-MM-DD] [--before YYYY-MM-DD] [--out DIR] [--chunk 200]
 *              [--import --source SOURCE_ID [--import-job-id ID]]   (needs FIBUKI_API_KEY)
 *
 * Output is always one JSON document on stdout.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { detectCSVFormat, getColumnSamples, parseCSV } from "../../../lib/import/csv-parser";
import {
  AMOUNT_PARSERS,
  detectAmountFormat,
  getAmountParserConfig,
  parseAmount,
} from "../../../lib/import/amount-parsers";
import {
  DATE_PARSERS,
  detectDateFormat,
  findDateColumnConflict,
  looksLikeDateColumn,
  parseDate,
} from "../../../lib/import/date-parsers";

const DEFAULT_BASE_URL = "https://fibuki.com";
const DEFAULT_CHUNK = 200;

type Flags = Record<string, string | true>;

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i++;
    }
  }
  return { positional, flags };
}

function fail(message: string, extra: Record<string, unknown> = {}): never {
  console.log(JSON.stringify({ ...extra, ok: false, error: message }, null, 2));
  process.exit(1);
}

function flag(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

/** UTF-8 first (BOM stripped); Austrian bank exports are often Windows-1252. */
export function decodeCsv(buffer: Buffer): { text: string; encoding: string } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, encoding: "UTF-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(buffer), encoding: "windows-1252" };
  }
}

/** Digits, separators, sign, currency only: keeps names and IBANs out of amount detection. */
const NUMERIC = /^[\s+\-(]*\d[\d.,\s'\u2019]*[)\-]?\s*(?:EUR|\u20ac)?$/i;

function looksNumeric(samples: string[]): boolean {
  return samples.length > 0 && samples.every((s) => NUMERIC.test(s));
}

/**
 * Which separator ends the amounts in a column: the last "." or "," followed by exactly
 * two digits ("89.99", "1.234,56", "-54,20 EUR"). Values with three digits after the
 * separator ("1.234") prove nothing and are not counted.
 */
export function decimalEvidence(values: string[]): { dot: number; comma: number } {
  let dot = 0;
  let comma = 0;
  for (const value of values) {
    const match = /([.,])(\d{2})(?!\d)\D*$/.exec(value.trim());
    if (match) match[1] === "." ? dot++ : comma++;
  }
  return { dot, comma };
}

/**
 * A running balance column proves the amounts: each row's balance must equal the
 * neighbouring row's balance plus its own amount. Files come oldest first or newest
 * first, so both directions are tried and the better one is reported.
 */
export function reconcileBalance(
  amounts: Array<number | null>,
  balances: Array<number | null>
): { checked: number; matched: number; direction: "oldest-first" | "newest-first" } {
  let checked = 0;
  let oldestFirst = 0;
  let newestFirst = 0;
  for (let i = 1; i < amounts.length; i++) {
    const [a, prevA, b, prevB] = [amounts[i], amounts[i - 1], balances[i], balances[i - 1]];
    if (a === null || prevA === null || b === null || prevB === null) continue;
    checked++;
    if (b - prevB === a) oldestFirst++;
    if (prevB - b === prevA) newestFirst++;
  }
  return newestFirst > oldestFirst
    ? { checked, matched: newestFirst, direction: "newest-first" }
    : { checked, matched: oldestFirst, direction: "oldest-first" };
}

function load(file: string, flags: Flags) {
  let buffer: Buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    fail(`Cannot read file: ${file}`);
  }
  const { text, encoding } = decodeCsv(buffer);
  const options = detectCSVFormat(text);
  // Some banks put the account holder and period above the table.
  const skip = Number(flag(flags, "skip") ?? 0);
  if (!Number.isInteger(skip) || skip < 0) fail("--skip must be a whole number of lines");
  options.skipRows = skip;
  const { headers, rows } = parseCSV(text, options);
  return { encoding, options, headers, rows };
}

function analyze(file: string, flags: Flags) {
  const { encoding, options, headers, rows } = load(file, flags);
  const columns = headers.map((name) => {
    const samples = getColumnSamples(rows, name, 20);
    const dateFormat = looksLikeDateColumn(samples) ? detectDateFormat(samples) : null;
    const amountFormat = !dateFormat && looksNumeric(samples) ? detectAmountFormat(samples) : null;
    return { name, samples: samples.slice(0, 3), dateFormat, amountFormat };
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        encoding,
        delimiter: options.delimiter,
        hasHeader: options.hasHeader,
        totalRows: rows.length,
        columns,
        dateFormats: DATE_PARSERS.map((p) => ({ id: p.id, name: p.name })),
        amountFormats: AMOUNT_PARSERS.map((p) => ({ id: p.id, name: p.name })),
      },
      null,
      2
    )
  );
}

interface Skipped {
  row: number;
  reason: string;
}

const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_WAIT_SECONDS = 60;

/** POST /api/mcp answers { success, result } or { success: false, error[, retryAfter] }. */
async function callTool(baseUrl: string, apiKey: string, tool: string, args: unknown) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ tool, arguments: args }),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const wait = Math.min(Number(body.retryAfter ?? response.headers.get("retry-after") ?? 1), MAX_RETRY_WAIT_SECONDS);
      await new Promise((done) => setTimeout(done, wait * 1000));
      continue;
    }
    if (!response.ok) {
      throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
    }
    return (body.result ?? body) as Record<string, unknown>;
  }
}

async function convert(file: string, flags: Flags) {
  const dateCol = flag(flags, "date");
  const amountCol = flag(flags, "amount");
  const debitCol = flag(flags, "debit");
  const creditCol = flag(flags, "credit");
  const nameCol = flag(flags, "name");
  if (!dateCol || !nameCol || (!amountCol && !(debitCol && creditCol))) {
    fail("Need --date, --name and either --amount or both --debit and --credit");
  }

  const { headers, rows } = load(file, flags);
  for (const col of [dateCol, amountCol, debitCol, creditCol, nameCol]) {
    if (col && !headers.includes(col)) fail(`No such column: ${col}`, { headers });
  }
  const optional = (name: string) => {
    const col = flag(flags, name);
    if (col && !headers.includes(col)) fail(`No such column: ${col}`, { headers });
    return col;
  };
  const descriptionCol = optional("description");
  const partnerCol = optional("partner");
  const referenceCol = optional("reference");
  const ibanCol = optional("iban");
  const currencyCol = optional("currency-col");
  const currency = flag(flags, "currency") ?? "EUR";

  const dateSamples = getColumnSamples(rows, dateCol, 50);
  const dateFormat = flag(flags, "date-format") ?? detectDateFormat(dateSamples);
  if (!dateFormat) {
    fail(`Could not detect a date format for column "${dateCol}"`, {
      samples: dateSamples.slice(0, 5),
      hint:
        "Usually every date has a day of 12 or less, so day and month could be swapped. Ask the user which comes first, then pass --date-format de (day first, 01.09.2026) or de-mdy (month first). Run analyze for the full list of formats.",
    });
  }

  const conflict = findDateColumnConflict(
    rows.map((r) => r[dateCol] ?? "").filter(Boolean),
    dateFormat
  );
  if (conflict) {
    fail("Day and month look swapped: importing would file dates under the wrong month", {
      dateFormat,
      suggestedDateFormat: conflict.suggestedParserId,
      offendingValue: conflict.offendingValue,
    });
  }

  const amountSource = amountCol ?? debitCol!;
  const amountFormat =
    flag(flags, "amount-format") ??
    detectAmountFormat(
      [
        ...getColumnSamples(rows, amountSource, 30),
        ...(creditCol ? getColumnSamples(rows, creditCol, 30) : []),
      ]
    );
  const amountConfig = amountFormat ? getAmountParserConfig(amountFormat) : null;
  if (!amountFormat || !amountConfig) fail(`Could not detect an amount format for column "${amountSource}"`);

  // Every row, not just the detection sample: if nearly all amounts end in ".dd" but the
  // chosen format reads "," as the decimal mark (or the reverse), the amounts would be off
  // by a factor of 100. Refuse rather than import them.
  const amountValues = rows.flatMap((r) => [r[amountSource] ?? "", ...(creditCol ? [r[creditCol] ?? ""] : [])]);
  const evidence = decimalEvidence(amountValues);
  const evidenceTotal = evidence.dot + evidence.comma;
  const winner = evidence.dot >= evidence.comma ? "." : ",";
  if (evidenceTotal >= 3 && Math.max(evidence.dot, evidence.comma) / evidenceTotal >= 0.8 && winner !== amountConfig.decimalSeparator) {
    fail("Amount format looks wrong: the values say one decimal mark, the format reads the other, so amounts would be off by a factor of 100", {
      amountFormat,
      decimalMarkInValues: winner,
      decimalMarkOfFormat: amountConfig.decimalSeparator,
      valuesEndingDotDD: evidence.dot,
      valuesEndingCommaDD: evidence.comma,
      hint: `Re-run with --amount-format ${winner === "." ? "us" : "de"}, or ask the user.`,
    });
  }

  const balanceCol = optional("balance");
  const warnings: string[] = [];
  let balanceCheck: ReturnType<typeof reconcileBalance> | null = null;

  const after = flag(flags, "after");
  const before = flag(flags, "before");

  const transactions: Array<Record<string, unknown>> = [];
  const skipped: Skipped[] = [];
  let outsideRange = 0;
  let income = 0;
  let expense = 0;

  rows.forEach((row, index) => {
    const line = index + 1;
    const date = parseDate(row[dateCol] ?? "", dateFormat);
    if (!date) return void skipped.push({ row: line, reason: `unreadable date "${row[dateCol] ?? ""}"` });
    const iso = date.toISOString().slice(0, 10);
    if ((after && iso <= after) || (before && iso > before)) {
      outsideRange++;
      return;
    }

    let cents: number | null;
    if (amountCol) {
      cents = parseAmount(row[amountCol] ?? "", amountConfig);
    } else {
      const debit = parseAmount(row[debitCol!] ?? "", amountConfig);
      const credit = parseAmount(row[creditCol!] ?? "", amountConfig);
      cents = debit ? -Math.abs(debit) : credit ? Math.abs(credit) : null;
    }
    if (cents === null) return void skipped.push({ row: line, reason: "no amount" });

    const name = (row[nameCol] ?? "").trim();
    if (!name) return void skipped.push({ row: line, reason: "empty name" });

    const tx: Record<string, unknown> = {
      date: iso,
      amount: cents,
      currency: ((currencyCol && row[currencyCol]) || currency).trim().toUpperCase(),
      name,
    };
    const put = (key: string, col: string | undefined) => {
      const value = col ? (row[col] ?? "").trim() : "";
      if (value) tx[key] = value;
    };
    put("description", descriptionCol);
    put("partner", partnerCol);
    put("reference", referenceCol);
    put("partnerIban", ibanCol);

    if (cents >= 0) income += cents;
    else expense += cents;
    transactions.push(tx);
  });

  if (balanceCol) {
    const amountOf = (row: Record<string, string>): number | null => {
      if (amountCol) return parseAmount(row[amountCol] ?? "", amountConfig);
      const debit = parseAmount(row[debitCol!] ?? "", amountConfig);
      const credit = parseAmount(row[creditCol!] ?? "", amountConfig);
      return debit ? -Math.abs(debit) : credit ? Math.abs(credit) : null;
    };
    balanceCheck = reconcileBalance(
      rows.map(amountOf),
      rows.map((r) => parseAmount(r[balanceCol] ?? "", amountConfig))
    );
    if (balanceCheck.checked < 3) {
      warnings.push("The balance column could not confirm the amounts (fewer than 3 comparable rows).");
    } else if (balanceCheck.matched / balanceCheck.checked < 0.9) {
      warnings.push(
        `The running balance does not add up: only ${balanceCheck.matched} of ${balanceCheck.checked} rows reconcile with their amount. ` +
          "Amounts, signs or the column choice are probably wrong; compare with the bank before importing."
      );
    }
  }

  const chunkSize = Number(flag(flags, "chunk") ?? DEFAULT_CHUNK);
  const outDir = resolve(flag(flags, "out") ?? "fibuki-import");
  const chunks: string[] = [];
  mkdirSync(outDir, { recursive: true });
  for (let i = 0; i < transactions.length; i += chunkSize) {
    const path = join(outDir, `chunk-${String(chunks.length + 1).padStart(3, "0")}.json`);
    writeFileSync(path, JSON.stringify(transactions.slice(i, i + chunkSize), null, 2));
    chunks.push(path);
  }

  const summary: Record<string, unknown> = {
    ok: true,
    dateFormat,
    amountFormat,
    rows: rows.length,
    valid: transactions.length,
    outsideRange,
    skipped,
    firstDate: transactions[0]?.date ?? null,
    lastDate: transactions[transactions.length - 1]?.date ?? null,
    incomeCents: income,
    expenseCents: expense,
    preview: transactions.slice(0, 5),
    balanceCheck,
    warnings,
    chunks,
  };

  if (flags.import) {
    const sourceId = flag(flags, "source");
    const apiKey = process.env.FIBUKI_API_KEY;
    if (!sourceId) fail("--import needs --source SOURCE_ID", summary);
    if (!apiKey) fail("--import needs FIBUKI_API_KEY in the environment (run: npx @fibukiapp/cli auth --format env)", summary);

    const baseUrl = process.env.FIBUKI_BASE_URL ?? DEFAULT_BASE_URL;
    // One id for the whole file: FiBuKI keeps identical lines of one import (two coffees,
    // same day) and skips only lines an EARLIER import stored. Pass the same id again
    // when resuming after a failure, so the chunks still count as one import.
    const importJobId = flag(flags, "import-job-id") ?? `api_csv_${Date.now()}_${randomUUID().slice(0, 8)}`;
    summary.importJobId = importJobId;
    let imported = 0;
    let duplicates = 0;
    let overLimit = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = JSON.parse(readFileSync(chunks[i], "utf8"));
      try {
        const result = await callTool(baseUrl, apiKey, "import_transactions", {
          sourceId,
          importJobId,
          transactions: chunk,
        });
        imported += Number(result.count ?? chunk.length);
        duplicates += Number(result.duplicateCount ?? 0);
        overLimit += Number(result.overLimitCount ?? 0);
      } catch (error) {
        // Chunks already sent stay imported; say exactly which, so nothing is sent twice.
        fail(`Import stopped at chunk ${i + 1} of ${chunks.length}: ${(error as Error).message}`, {
          ...summary,
          importedBeforeFailure: imported,
          duplicatesBeforeFailure: duplicates,
          chunksDone: i,
          resumeWithChunk: chunks[i],
          resumeWithImportJobId: importJobId,
        });
      }
    }
    summary.imported = imported;
    summary.alreadyImported = duplicates;
    summary.overQuota = overLimit;
  }

  console.log(JSON.stringify(summary, null, 2));
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, file] = positional;
  if (command === "analyze" && file) return analyze(file, flags);
  if (command === "convert" && file) return convert(file, flags);
  fail("Usage: fibuki-csv analyze <file> | fibuki-csv convert <file> --date COL --amount COL --name COL [...]");
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
