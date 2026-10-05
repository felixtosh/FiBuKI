/**
 * #619: the SEPA collection sentence is a Debit Date, "frühestens" included.
 *
 * A telecom Partner prints "Der Gesamtbetrag wird frühestens am 20.06.2026
 * [...] per SEPA-Mandat [...] eingezogen". Files extracted before the field
 * vocabulary stored that date as a keyless "Zahlungstermin" row, so it counted
 * as a Due Date and lost the Debit Date's settlement lag and near-proof.
 *
 * The model is stubbed, so these cases pin what the code controls: the prompt
 * states the rule for this wording, and a reply that follows it reaches the
 * typed Debit Date (and not the Due Date) through the real closed-vocabulary
 * filter and reader. Whether a live model follows the rule is checked by
 * re-extracting one real File; that is the deployment owner's step.
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
import { debitDateFromAdditionalFields } from "../../matching/debitDate";
import { dueDateFromAdditionalFields } from "../../matching/dueDate";

const ISSUE = new Date(2026, 5, 2);
const SENTENCE =
  "Der Gesamtbetrag wird frühestens am 20.06.2026 von Ihrem Konto per SEPA-Mandat eingezogen";

beforeEach(() => {
  process.env.GCLOUD_PROJECT = "sepa-debit-date-test-project";
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

describe("the Extraction prompt: the SEPA collection sentence (#619)", () => {
  it("names the 'wird (frühestens) am <date> ... eingezogen' sentence as a debit date", async () => {
    const prompt = await extractionPrompt();
    expect(prompt).toContain('"wird (frühestens) am <date> ... eingezogen"');
    expect(prompt).toMatch(/under a SEPA mandate is a debit date/);
  });

  it("shows the telecom wording, with words between the date and 'eingezogen', mapped to debitDate", async () => {
    const prompt = await extractionPrompt();
    expect(prompt).toContain("wird frühestens am\n  20.06.2026 von Ihrem Konto per SEPA-Mandat eingezogen");
    expect(prompt).toContain('"debitDate"\n  "2026-06-20"');
  });

  it("says 'frühestens' does not change what the date is", async () => {
    const prompt = await extractionPrompt();
    expect(prompt).toMatch(/"frühestens" \(at the earliest\) does not make it anything\s+other than a debit date/);
  });

  it("forbids filing the collection date as a due date, even when no other date is printed", async () => {
    const prompt = await extractionPrompt();
    expect(prompt).toMatch(/A SEPA collection sentence is never a due date/);
    expect(prompt).toMatch(/not even when the document prints no other date to pay by/);
  });
});

describe("a document printing only the SEPA collection sentence", () => {
  it("yields a Debit Date and no Due Date from a reply that follows the prompt", async () => {
    gemini.queue.push(
      JSON.stringify({
        extracted: { date: "2026-06-02", amount: 4990 },
        additionalFields: [
          {
            key: "debitDate",
            label: "wird frühestens am ... per SEPA-Mandat eingezogen",
            value: "2026-06-20",
            rawValue: SENTENCE,
          },
        ],
      })
    );
    const res = await parseWithGemini(Buffer.from("x"), "application/pdf");

    // The row survives the closed-vocabulary filter…
    expect(res.additionalFields).toEqual([
      expect.objectContaining({ key: "debitDate", value: "2026-06-20" }),
    ]);
    // …and the reader that writes `extractedDebitDate` accepts it, "frühestens" and all.
    const debit = debitDateFromAdditionalFields(res.additionalFields, ISSUE);
    expect(debit).not.toBeNull();
    expect([debit!.getFullYear(), debit!.getMonth(), debit!.getDate()]).toEqual([2026, 5, 20]);
    // It is not also a Due Date.
    expect(dueDateFromAdditionalFields(res.additionalFields, ISSUE)).toBeNull();
  });

  it("the legacy keyless 'Zahlungstermin' row is a Due Date and no Debit Date: what the sweep repairs", () => {
    const legacy = [{ label: "Zahlungstermin", value: "2026-06-20" }];
    expect(dueDateFromAdditionalFields(legacy, ISSUE)).not.toBeNull();
    expect(debitDateFromAdditionalFields(legacy, ISSUE)).toBeNull();
  });
});
