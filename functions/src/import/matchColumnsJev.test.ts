/**
 * The Jev column-matching backend is a pure mapping around one API call, so
 * everything except the HTTP request is testable without a network: question
 * construction (including the drift guard that every valid format id is
 * offered to the model), state building, answer mapping, and the provider
 * switch. The shared post-processing is covered through the same shapes the
 * Jev backend produces (notably two columns answering "amount", which the
 * Soll/Haben legacy export really does).
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  buildJevColumnState,
  buildJevColumnQuestions,
  mapJevAnswers,
  columnMatchProvider,
  typesafeAllowedFor,
} from "./matchColumnsJev";
import { postProcessColumnResult } from "./matchColumns";
import { DATE_FORMATS, AMOUNT_FORMATS, TRANSACTION_FIELDS } from "./columnFields";
import type { JevResponse } from "../utils/typesafe";

const HEADERS = ["Buchungsdatum", "Betrag", "Buchungstext"];
const ROWS = [
  { Buchungsdatum: "01.09.2026", Betrag: "-54,20", Buchungstext: "POS REWE DANKT" },
  { Buchungsdatum: "03.09.2026", Betrag: "-39,90", Buchungstext: "A1 Rechnung" },
];

function choiceAnswer(choice: string, confidence = 0.95) {
  return { type: "choice" as const, choice, probabilities: { [choice]: confidence }, confidence };
}

describe("columnMatchProvider", () => {
  const saved = process.env.FIBUKI_COLUMN_MATCH_PROVIDER;
  afterEach(() => {
    if (saved === undefined) delete process.env.FIBUKI_COLUMN_MATCH_PROVIDER;
    else process.env.FIBUKI_COLUMN_MATCH_PROVIDER = saved;
  });

  it("defaults to gemini", () => {
    delete process.env.FIBUKI_COLUMN_MATCH_PROVIDER;
    expect(columnMatchProvider()).toBe("gemini");
  });

  it("accepts typesafe (case-insensitive)", () => {
    process.env.FIBUKI_COLUMN_MATCH_PROVIDER = "TypeSafe";
    expect(columnMatchProvider()).toBe("typesafe");
  });

  it("throws on an unknown provider instead of silently defaulting", () => {
    process.env.FIBUKI_COLUMN_MATCH_PROVIDER = "typsafe";
    expect(() => columnMatchProvider()).toThrow(/typsafe/);
  });
});

describe("typesafeAllowedFor", () => {
  const saved = process.env.FIBUKI_COLUMN_MATCH_TYPESAFE_USERS;
  afterEach(() => {
    if (saved === undefined) delete process.env.FIBUKI_COLUMN_MATCH_TYPESAFE_USERS;
    else process.env.FIBUKI_COLUMN_MATCH_TYPESAFE_USERS = saved;
  });

  it("allows everyone when unset", () => {
    delete process.env.FIBUKI_COLUMN_MATCH_TYPESAFE_USERS;
    expect(typesafeAllowedFor("u1")).toBe(true);
  });

  it("allows only listed uids or emails when set", () => {
    process.env.FIBUKI_COLUMN_MATCH_TYPESAFE_USERS = " u1 , Tester@Example.com ";
    expect(typesafeAllowedFor("u1")).toBe(true);
    expect(typesafeAllowedFor("u2", "tester@example.com")).toBe(true);
    expect(typesafeAllowedFor("u2", "other@example.com")).toBe(false);
    expect(typesafeAllowedFor("u2")).toBe(false);
  });
});

describe("buildJevColumnQuestions", () => {
  const questions = buildJevColumnQuestions(HEADERS);

  it("asks one question per column plus three format questions", () => {
    expect(Object.keys(questions)).toHaveLength(HEADERS.length + 3);
    expect(questions.fmt_date).toBeDefined();
    expect(questions.fmt_amount).toBeDefined();
    expect(questions.fmt_balance).toBeDefined();
  });

  it("offers every target field key plus none on each column question", () => {
    const criteria = questions.col_0;
    if (criteria.type !== "choice") throw new Error("expected choice");
    const keys = Object.keys(criteria.criteria);
    for (const f of TRANSACTION_FIELDS) expect(keys).toContain(f.key);
    expect(keys).toContain("none");
  });

  // Drift guard: a format id added to columnFields.ts but not described here
  // would be a format Jev can never suggest — the same failure mode #303
  // guards against for date-parsers.ts.
  it("offers every valid date and amount format id", () => {
    const dateQ = questions.fmt_date;
    const amountQ = questions.fmt_amount;
    if (dateQ.type !== "choice" || amountQ.type !== "choice") throw new Error("expected choice");
    for (const id of DATE_FORMATS) expect(Object.keys(dateQ.criteria)).toContain(id);
    for (const id of AMOUNT_FORMATS) expect(Object.keys(amountQ.criteria)).toContain(id);
  });
});

describe("buildJevColumnState", () => {
  it("carries header, samples and index per column", () => {
    const state = buildJevColumnState(HEADERS, ROWS);
    expect(state.columns).toHaveLength(3);
    expect(state.columns[0]).toMatchObject({
      index: 0,
      header: "Buchungsdatum",
      samples: ["01.09.2026", "03.09.2026"],
      allValuesIdentical: false,
    });
  });

  it("flags a column whose values are all identical (account owner)", () => {
    const rows = [
      { Konto: "AT12", Betrag: "1,00" },
      { Konto: "AT12", Betrag: "2,00" },
    ];
    const state = buildJevColumnState(["Konto", "Betrag"], rows);
    expect(state.columns[0].allValuesIdentical).toBe(true);
    expect(state.columns[1].allValuesIdentical).toBe(false);
  });
});

describe("mapJevAnswers", () => {
  it("maps choices to fields and none to null", () => {
    const response: JevResponse = {
      model: "jev-latest",
      answers: {
        col_0: choiceAnswer("date"),
        col_1: choiceAnswer("amount"),
        col_2: choiceAnswer("none", 0.8),
        fmt_date: choiceAnswer("de"),
        fmt_amount: choiceAnswer("simple-comma"),
        fmt_balance: choiceAnswer("none"),
      },
    };
    const result = mapJevAnswers(HEADERS, response);
    expect(result.mappings).toEqual([
      { csvColumn: "Buchungsdatum", targetField: "date", confidence: 0.95 },
      { csvColumn: "Betrag", targetField: "amount", confidence: 0.95 },
      { csvColumn: "Buchungstext", targetField: null, confidence: 0.8 },
    ]);
    expect(result.suggestedDateFormat).toBe("de");
    expect(result.suggestedAmountFormat).toBe("simple-comma");
    expect(result.suggestedBalanceFormat).toBeNull();
  });

  it("treats a missing answer as unmapped with zero confidence", () => {
    const response: JevResponse = {
      model: "jev-latest",
      answers: { col_0: choiceAnswer("date") },
    };
    const result = mapJevAnswers(HEADERS, response);
    expect(result.mappings[1]).toEqual({ csvColumn: "Betrag", targetField: null, confidence: 0 });
    expect(result.suggestedDateFormat).toBeNull();
  });
});

describe("postProcessColumnResult on Jev-shaped results", () => {
  it("dedupes two columns that both answered amount, keeping the higher confidence", () => {
    const response: JevResponse = {
      model: "jev-latest",
      answers: {
        col_0: choiceAnswer("date"),
        col_1: choiceAnswer("amount", 0.99),
        col_2: choiceAnswer("amount", 0.93),
        fmt_date: choiceAnswer("de-short"),
        fmt_amount: choiceAnswer("de"),
        fmt_balance: choiceAnswer("none"),
      },
    };
    const result = postProcessColumnResult(mapJevAnswers(["Valuta", "Soll", "Haben"], response));
    expect(result.mappings[1]).toMatchObject({ csvColumn: "Soll", targetField: "amount" });
    expect(result.mappings[2]).toMatchObject({ csvColumn: "Haben", targetField: null, confidence: 0 });
    // Balance format falls back to the amount format when unanswered
    expect(result.suggestedBalanceFormat).toBe("de");
  });
});
