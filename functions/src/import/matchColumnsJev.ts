/**
 * CSV column matching via TypeSafe Jev (System One decision model).
 *
 * The whole matchColumns response is enumerable — per column one of the nine
 * target field keys or none, plus a date/amount/balance format id from fixed
 * lists — so it fits Jev's Choice primitive exactly: one API call carries a
 * fan-out of one question per column plus three format questions, and every
 * answer is guaranteed to be one of the offered keys (no JSON parsing, no
 * out-of-vocabulary field names) with calibrated confidence per column.
 *
 * Opt-in via FIBUKI_COLUMN_MATCH_PROVIDER=typesafe (see columnMatchProvider).
 * Spike accuracy/latency numbers: handoffs/2026-09-27-jev-decision-provider.md.
 */

import { callJev, JevQuestion, JevResponse } from "../utils/typesafe";
import { MODELS } from "../utils/models";
import {
  TRANSACTION_FIELDS,
  DATE_FORMATS,
  AMOUNT_FORMATS,
  MatchColumnsResponse,
} from "./columnFields";

export type ColumnMatchProvider = "gemini" | "typesafe";

/**
 * Which backend serves column matching. Default is Gemini (current behavior);
 * `typesafe` is opt-in per deployment. An unknown value throws rather than
 * silently serving the default, so a typo'd env var is a loud failure.
 */
export function columnMatchProvider(): ColumnMatchProvider {
  const raw = process.env.FIBUKI_COLUMN_MATCH_PROVIDER?.trim().toLowerCase();
  if (!raw || raw === "gemini") return "gemini";
  if (raw === "typesafe") return "typesafe";
  throw new Error(
    `FIBUKI_COLUMN_MATCH_PROVIDER="${raw}" is not one of: gemini, typesafe`,
  );
}

/**
 * Optional per-user gate: FIBUKI_COLUMN_MATCH_TYPESAFE_USERS is a comma list of
 * user ids and/or emails. When set, only those users are routed to Jev and
 * everyone else stays on Gemini, so a multi-tenant deployment can trial Jev
 * without sending other tenants' CSV samples to TypeSafe. Unset = everyone.
 */
export function typesafeAllowedFor(userId: string, email?: string | null): boolean {
  const raw = process.env.FIBUKI_COLUMN_MATCH_TYPESAFE_USERS?.trim();
  if (!raw) return true;
  const allowed = new Set(
    raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  return allowed.has(userId.toLowerCase()) || (!!email && allowed.has(email.toLowerCase()));
}

// "none" must not collide with a real field key.
const NONE_KEY = "none";

// Question keys are index-based because CSV headers are user data: they can
// repeat, be empty, or collide with the format question keys.
const colKey = (i: number) => `col_${i}`;
const FMT_DATE = "fmt_date";
const FMT_AMOUNT = "fmt_amount";
const FMT_BALANCE = "fmt_balance";

/**
 * Descriptions for each format id, needed because Choice criteria are
 * key -> meaning. Day-first vs month-first pairs share a surface pattern, so
 * the criteria spell out how to disambiguate from sample values.
 */
const DATE_FORMAT_CRITERIA: Record<string, string> = {
  "iso-datetime": "2024-03-15 14:30:00 (ISO date, space, time)",
  "iso-datetime-t": "2024-03-15T14:30:00 (ISO date, T separator, time)",
  iso: "2024-03-15 (ISO date only)",
  de: "15.03.2024 — dotted, DAY first (Austrian/German standard)",
  "de-mdy": "03.15.2024 — dotted, MONTH first; only if samples prove it (second part > 12)",
  "de-short": "15.03.24 — dotted, day first, 2-digit year",
  "de-mdy-short": "03.15.24 — dotted, month first, 2-digit year",
  us: "03/15/2024 — slashes, MONTH first (US)",
  "us-short": "03/15/24 — slashes, month first, 2-digit year",
  "eu-slash": "15/03/2024 — slashes, DAY first",
  "eu-slash-short": "15/03/24 — slashes, day first, 2-digit year",
  "dash-dmy": "15-03-2024 — dashes, day first",
  "dash-mdy": "03-15-2024 — dashes, month first",
  "dash-dmy-short": "15-03-24 — dashes, day first, 2-digit year",
  "dash-mdy-short": "03-15-24 — dashes, month first, 2-digit year",
  "text-short": "15-Mar-2024 — abbreviated month name",
  "text-long": "15 March 2024 — full month name",
  [NONE_KEY]: "No date column present, or none of the formats fits",
};

const AMOUNT_FORMAT_CRITERIA: Record<string, string> = {
  de: "1.234,56 — dot thousands separator, comma decimal (German)",
  "de-space": "1 234,56 — space thousands separator, comma decimal",
  us: "1,234.56 — comma thousands separator, dot decimal",
  "us-space": "1 234.56 — space thousands separator, dot decimal",
  accounting: "(1,234.56) — negatives in parentheses, US separators",
  "accounting-de": "(1.234,56) — negatives in parentheses, German separators",
  simple: "1234.56 — NO thousands separator, dot decimal (4480.00, -121.52)",
  "simple-comma": "1234,56 — NO thousands separator, comma decimal",
  [NONE_KEY]: "No such column present, or none of the formats fits",
};

export interface JevColumnState {
  description: string;
  columns: Array<{
    index: number;
    header: string;
    samples: string[];
    allValuesIdentical: boolean;
  }>;
}

export function buildJevColumnState(
  headers: string[],
  sampleRows: Record<string, string>[],
): JevColumnState {
  return {
    description:
      "Columns of a bank-transaction CSV export (Austrian/German accounting tool). " +
      "Judge by the SAMPLE VALUES, not the header: a 'Description' column holding " +
      "company names is the counterparty; an 'ID' column holding UUIDs is the " +
      "reference. A column whose values are all identical is the account owner, " +
      "never the counterparty.",
    columns: headers.map((header, index) => {
      const samples = sampleRows
        .slice(0, 10)
        .map((row) => row[header])
        .filter((v) => v && v.trim());
      const unique = new Set(samples);
      return {
        index,
        header,
        samples: samples.slice(0, 3),
        allValuesIdentical: samples.length > 1 && unique.size === 1,
      };
    }),
  };
}

export function buildJevColumnQuestions(
  headers: string[],
): Record<string, JevQuestion> {
  const fieldCriteria: Record<string, string> = Object.fromEntries(
    TRANSACTION_FIELDS.map((f) => [f.key, `${f.label}: ${f.description}`]),
  );
  fieldCriteria[NONE_KEY] =
    "Do not import this column (currency-only columns, internal codes, account-owner columns, empty columns, or a worse duplicate of a field another column serves better)";

  const questions: Record<string, JevQuestion> = {};
  headers.forEach((header, i) => {
    questions[colKey(i)] = {
      type: "choice",
      instructions:
        `Which import field does CSV column ${i} ("${header}", see its samples in state) map to? ` +
        "Judge by sample values over the header name. A 'Total Amount' column beats a plain " +
        "'Amount' column for the amount field; the loser maps to none.",
      criteria: fieldCriteria,
    };
  });

  questions[FMT_DATE] = {
    type: "choice",
    instructions:
      "Which date format do the date column's sample values use? Day-first is the default " +
      "for Austrian/German exports unless a sample proves month-first.",
    criteria: DATE_FORMAT_CRITERIA,
  };
  questions[FMT_AMOUNT] = {
    type: "choice",
    instructions: "Which number format do the transaction amount column's sample values use?",
    criteria: AMOUNT_FORMAT_CRITERIA,
  };
  questions[FMT_BALANCE] = {
    type: "choice",
    instructions:
      "Which number format does the balance-after-transaction column use, if such a column exists?",
    criteria: AMOUNT_FORMAT_CRITERIA,
  };
  return questions;
}

/**
 * Map Jev answers back into the MatchColumnsResponse shape. Purely mechanical:
 * `none` and missing answers become null mappings, format `none` becomes null.
 * Cross-column dedup and format fallbacks are applied by the shared
 * post-processing in matchColumns.ts, same as for the Gemini backend.
 */
export function mapJevAnswers(
  headers: string[],
  response: JevResponse,
): MatchColumnsResponse {
  const mappings = headers.map((header, i) => {
    const answer = response.answers[colKey(i)];
    if (!answer || answer.type !== "choice") {
      return { csvColumn: header, targetField: null, confidence: 0 };
    }
    return {
      csvColumn: header,
      targetField: answer.choice === NONE_KEY ? null : answer.choice,
      confidence: Math.min(1, Math.max(0, answer.confidence ?? 0)),
    };
  });

  const fmt = (key: string, valid: string[]): string | null => {
    const answer = response.answers[key];
    if (!answer || answer.type !== "choice" || answer.choice === NONE_KEY) return null;
    return valid.includes(answer.choice) ? answer.choice : null;
  };

  return {
    mappings,
    suggestedDateFormat: fmt(FMT_DATE, DATE_FORMATS),
    suggestedAmountFormat: fmt(FMT_AMOUNT, AMOUNT_FORMATS),
    suggestedBalanceFormat: fmt(FMT_BALANCE, AMOUNT_FORMATS),
  };
}

export interface JevColumnMatchResult {
  result: MatchColumnsResponse;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export async function matchColumnsViaJev(
  headers: string[],
  sampleRows: Record<string, string>[],
): Promise<JevColumnMatchResult> {
  const state = buildJevColumnState(headers, sampleRows);
  const questions = buildJevColumnQuestions(headers);
  const response = await callJev(state, questions, { model: MODELS.jevDecision });
  return {
    result: mapJevAnswers(headers, response),
    model: MODELS.jevDecision,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };
}
