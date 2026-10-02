import { describe, it, expect } from "vitest";
import {
  buildRecurrencePrompt,
  isVerdictFresh,
  parseRecurrenceAnswer,
  recurrenceKey,
  type RecurrenceCheckInput,
} from "../recurrenceCheck";

const billa: RecurrenceCheckInput = {
  partnerName: "REWE International AG",
  aliases: ["BILLA", "Penny"],
  website: "rewe-group.at",
  cycles: [
    { frequencyDays: 7, frequencyConfidence: 66, amountBand: -3272.78, sampleSize: 9 },
    { frequencyDays: 5, frequencyConfidence: 55, amountBand: -850.17, sampleSize: 6 },
  ],
  charges: [{ date: new Date("2024-12-30T00:00:00Z"), amount: -3529, description: "BILLA DANKT 1234" }],
};

const ts = (ms: number) => ({ toMillis: () => ms });

describe("recurrenceKey", () => {
  it("ignores case, spacing and cadence order", () => {
    const shuffled = { ...billa, partnerName: " rewe international ag ", cycles: [...billa.cycles].reverse() };
    expect(recurrenceKey(shuffled)).toBe(recurrenceKey(billa));
    expect(recurrenceKey(billa)).toBe("rewe international ag|5,7");
  });

  it("changes when a cadence changes", () => {
    const monthly = { ...billa, cycles: [{ ...billa.cycles[0], frequencyDays: 30 }] };
    expect(recurrenceKey(monthly)).not.toBe(recurrenceKey(billa));
  });
});

describe("isVerdictFresh", () => {
  const now = Date.UTC(2026, 9, 2);
  const key = recurrenceKey(billa);

  it("accepts a recent verdict for the same question", () => {
    expect(isVerdictFresh({ recurring: false, key, checkedAt: ts(now - 1000) }, key, now)).toBe(true);
  });

  it("rejects a verdict for another question, an old one, or none", () => {
    expect(isVerdictFresh({ recurring: false, key: "other", checkedAt: ts(now) }, key, now)).toBe(false);
    expect(isVerdictFresh({ recurring: false, key, checkedAt: ts(now - 200 * 86_400_000) }, key, now)).toBe(false);
    expect(isVerdictFresh(undefined, key, now)).toBe(false);
    expect(isVerdictFresh({ key, checkedAt: ts(now) }, key, now)).toBe(false);
  });
});

describe("parseRecurrenceAnswer", () => {
  it("reads plain and fenced JSON", () => {
    expect(parseRecurrenceAnswer('{"recurring": false, "reason": "Supermarket"}')).toEqual({
      recurring: false,
      reason: "Supermarket",
    });
    expect(parseRecurrenceAnswer('```json\n{"recurring": true, "reason": "iCloud plan"}\n```')).toEqual({
      recurring: true,
      reason: "iCloud plan",
    });
  });

  it("refuses anything without a boolean verdict", () => {
    expect(parseRecurrenceAnswer("yes")).toBeNull();
    expect(parseRecurrenceAnswer('{"recurring": "maybe"}')).toBeNull();
  });
});

describe("buildRecurrencePrompt", () => {
  it("shows the merchant, its cadences in euros and its recent charges", () => {
    const prompt = buildRecurrencePrompt(billa);
    expect(prompt).toContain("Merchant: REWE International AG");
    expect(prompt).toContain("BILLA, Penny");
    expect(prompt).toContain("every ~7 days, around 32.73");
    expect(prompt).toContain("2024-12-30  -35.29  BILLA DANKT 1234");
  });
});
