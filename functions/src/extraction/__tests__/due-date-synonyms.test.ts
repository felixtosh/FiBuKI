/**
 * #135: Extraction reads the Due Date (Fälligkeitsdatum) under the full
 * German synonym set, and never a Zahlungsziel.
 *
 * The prompt used to establish only one wording, so a document printing any
 * other synonym left the typed Due Date empty and the payment window (#236)
 * collapsed to a point. Widening has one hard edge: a Zahlungsziel is a
 * period ("14 Tage"), not a date, and the window scores anything inside
 * [issueDate, dueDate] as an exact hit, so a wrong Due Date manufactures
 * confident false Matches where a missing one merely fails to find true
 * ones. The same inversion happens when a misread lands the Due Date before
 * the issue date, so that is rejected too.
 *
 * The AI/network boundary is stubbed the way extraction-characterization
 * does it; everything downstream (the closed-vocabulary filter, the Due Date
 * reader that writes the typed field) is real application code.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const gemini = vi.hoisted(() => ({
  queue: [] as string[],
  requests: [] as Array<{ contents: Array<{ parts: Array<Record<string, unknown>> }> }>,
}));

vi.mock("@google-cloud/vertexai", () => ({
  VertexAI: class {
    getGenerativeModel() {
      return {
        generateContent: async (req: unknown) => {
          gemini.requests.push(req as (typeof gemini.requests)[number]);
          return {
            response: {
              candidates: [
                { content: { role: "model", parts: [{ text: gemini.queue.shift() ?? "{}" }] } },
              ],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            },
          };
        },
      };
    }
  },
}));

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({ collection: () => ({}) }),
  Timestamp: { fromDate: (d: Date) => d, now: () => new Date() },
}));
vi.mock("firebase-admin/storage", () => ({ getStorage: () => ({}) }));

import { parseWithGemini } from "../geminiParser";
import { dueDateFromAdditionalFields } from "../../matching/dueDate";

const ISSUE = new Date(Date.UTC(2026, 0, 5));

beforeEach(() => {
  process.env.GCLOUD_PROJECT = "due-date-test-project";
  gemini.queue.length = 0;
  gemini.requests.length = 0;
});

/** The extraction prompt of the one request a parse sends. */
async function extractionPrompt(): Promise<string> {
  gemini.queue.push("{}");
  await parseWithGemini(Buffer.from("x"), "application/pdf");
  const textPart = gemini.requests[0].contents[0].parts.find((p) => typeof p.text === "string");
  return (textPart?.text as string) ?? "";
}

describe("the Extraction prompt: the Due Date synonym set (#135)", () => {
  it("names every printed synonym of the Fälligkeitsdatum, not one headword", async () => {
    const prompt = await extractionPrompt();
    // The set is CONTEXT.md's "_Also printed as_" list for Due Date, plus the
    // headword itself. An unlisted synonym is a field that silently fails.
    for (const synonym of [
      "Fälligkeitsdatum",
      "Zahlungstermin",
      "fällig am",
      "zahlbar bis",
      "Zahlbar ohne Abzug bis",
    ]) {
      expect(prompt).toContain(synonym);
    }
  });

  it("states that a Zahlungsziel is a period and never a due date", async () => {
    const prompt = await extractionPrompt();
    expect(prompt).toMatch(/"Zahlungsziel" is NOT a due date/);
    expect(prompt).toMatch(/NEVER add it to the invoice date/);
  });

  it("forbids guessing: no due date printed means no dueDate field", async () => {
    const prompt = await extractionPrompt();
    expect(prompt).toMatch(/prints no due date, return NO "dueDate" field/);
    expect(prompt).toMatch(/Never return a "dueDate" earlier than the invoice date/);
  });
});

describe("a document printing a synonym other than Zahlungstermin", () => {
  it("populates the typed Due Date from a 'Zahlbar bis' row", async () => {
    gemini.queue.push(
      JSON.stringify({
        extracted: { date: "2026-01-05", amount: 12000 },
        additionalFields: [
          { key: "dueDate", label: "Zahlbar bis", value: "2026-01-20", rawValue: "20.01.2026" },
        ],
      })
    );
    const res = await parseWithGemini(Buffer.from("x"), "application/pdf");
    // The row survives the closed-vocabulary filter with its printed label…
    expect(res.additionalFields).toEqual([
      { key: "dueDate", label: "Zahlbar bis", value: "2026-01-20", rawValue: "20.01.2026" },
    ]);
    // …and the reader that writes `extractedDueDate` accepts it.
    const due = dueDateFromAdditionalFields(res.additionalFields, ISSUE);
    expect(due).not.toBeNull();
    expect([due!.getUTCFullYear(), due!.getUTCMonth(), due!.getUTCDate()]).toEqual([2026, 0, 20]);
  });
});

describe("a document printing a Zahlungsziel", () => {
  // The document prints "Zahlungsziel: 14 Tage" and no due date. This is the
  // single most important case in #135: read as a date it inverts the
  // payment window into a source of confident false Matches.

  it("yields no Due Date when the model files it where it belongs", async () => {
    gemini.queue.push(
      JSON.stringify({
        extracted: { date: "2026-01-05", amount: 12000 },
        additionalFields: [
          { key: "paymentTerms", label: "Zahlungsziel", value: "14 Tage", rawValue: "14 Tage" },
        ],
      })
    );
    const res = await parseWithGemini(Buffer.from("x"), "application/pdf");
    expect(dueDateFromAdditionalFields(res.additionalFields, ISSUE)).toBeNull();
  });

  it("yields no Due Date even when a model computes a date from the period", async () => {
    // A prompt is a request. A model that ignores it and manufactures
    // issue date + 14 Tage under the dueDate key is stopped by the label
    // guard in code, which survives a model swap.
    gemini.queue.push(
      JSON.stringify({
        extracted: { date: "2026-01-05", amount: 12000 },
        additionalFields: [
          { key: "dueDate", label: "Zahlungsziel", value: "2026-01-19", rawValue: "14 Tage" },
        ],
      })
    );
    const res = await parseWithGemini(Buffer.from("x"), "application/pdf");
    expect(dueDateFromAdditionalFields(res.additionalFields, ISSUE)).toBeNull();
  });
});

describe("a document printing no due date", () => {
  it("leaves the field empty rather than guessing", async () => {
    gemini.queue.push(
      JSON.stringify({
        extracted: { date: "2026-01-05", amount: 12000 },
        additionalFields: [
          { key: "invoiceNumber", label: "Rechnungsnummer", value: "2026-0042" },
        ],
      })
    );
    const res = await parseWithGemini(Buffer.from("x"), "application/pdf");
    expect(dueDateFromAdditionalFields(res.additionalFields, ISSUE)).toBeNull();
  });
});

describe("a due date earlier than the issue date", () => {
  it("is rejected rather than written: it inverts the payment window", async () => {
    gemini.queue.push(
      JSON.stringify({
        extracted: { date: "2026-01-05", amount: 12000 },
        additionalFields: [
          { key: "dueDate", label: "Fällig am", value: "2026-01-02", rawValue: "02.01.2026" },
        ],
      })
    );
    const res = await parseWithGemini(Buffer.from("x"), "application/pdf");
    expect(dueDateFromAdditionalFields(res.additionalFields, ISSUE)).toBeNull();
  });

  it("accepts a due date equal to the issue date (zahlbar sofort)", async () => {
    gemini.queue.push(
      JSON.stringify({
        extracted: { date: "2026-01-05", amount: 12000 },
        additionalFields: [
          { key: "dueDate", label: "fällig am", value: "2026-01-05", rawValue: "05.01.2026" },
        ],
      })
    );
    const res = await parseWithGemini(Buffer.from("x"), "application/pdf");
    expect(dueDateFromAdditionalFields(res.additionalFields, ISSUE)?.getUTCDate()).toBe(5);
  });
});
