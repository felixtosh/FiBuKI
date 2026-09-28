/**
 * #183: the Connect dialog's search box promises "Search by name or amount
 * (e.g. 123,45)". This is the one predicate behind that promise, shared by the
 * server candidate gate (findTransactionMatches.ts) and the dialogs' client
 * filter, so the list cannot change as the debounce resolves.
 */

import { readFileSync } from "fs";
import path from "path";
import { describe, it, expect } from "vitest";
import {
  matchesAmountQuery,
  matchesTransactionSearch,
  parseAmountQuery,
} from "../transactionSearch";

const tx = (amount: number, name = "Some payee", extra: Record<string, unknown> = {}) => ({
  name,
  partner: null,
  reference: null,
  amount,
  ...extra,
});

describe("parseAmountQuery", () => {
  it("detects a numeric query, stripping the euro sign, spaces and sign", () => {
    expect(parseAmountQuery("214,20")).toBe("214,20");
    expect(parseAmountQuery("€ 214,20")).toBe("214,20");
    expect(parseAmountQuery(" 214.20 € ")).toBe("214.20");
    expect(parseAmountQuery("-214,20")).toBe("214,20");
    expect(parseAmountQuery("21420")).toBe("21420");
  });

  it("does not treat text as an amount", () => {
    expect(parseAmountQuery("rewe")).toBeNull();
    expect(parseAmountQuery("SG5RF2145")).toBeNull();
    expect(parseAmountQuery("€")).toBeNull();
    expect(parseAmountQuery(",")).toBeNull();
    expect(parseAmountQuery("")).toBeNull();
  });
});

describe("matchesAmountQuery", () => {
  it("214,20 finds the transaction of 214,20 and of -214,20", () => {
    expect(matchesAmountQuery(21420, "214,20")).toBe(true);
    expect(matchesAmountQuery(-21420, "214,20")).toBe(true);
  });

  it("214.20, 214,20, € 214,20 and 21420 all find the same transaction", () => {
    for (const q of ["214.20", "214,20", "€ 214,20", "21420"]) {
      expect(matchesAmountQuery(-21420, q)).toBe(true);
    }
  });

  it("a partial query stays useful: 214 finds 214,20 and 2.140,00", () => {
    expect(matchesAmountQuery(-21420, "214")).toBe(true);
    expect(matchesAmountQuery(-214000, "214")).toBe(true);
    expect(matchesAmountQuery(-956, "214")).toBe(false);
  });

  it("accepts the grouped and the ungrouped de-AT forms", () => {
    expect(matchesAmountQuery(-123456, "1.234,56")).toBe(true);
    expect(matchesAmountQuery(-123456, "1234,56")).toBe(true);
    expect(matchesAmountQuery(-123456, "1234.56")).toBe(true);
  });

  it("a non-numeric query or a missing amount never matches", () => {
    expect(matchesAmountQuery(-21420, "rewe")).toBe(false);
    expect(matchesAmountQuery(undefined, "214")).toBe(false);
    expect(matchesAmountQuery(null, "214")).toBe(false);
  });
});

describe("matchesTransactionSearch", () => {
  it("the observed case: 214 finds 214,20, and text still finds the reference hit", () => {
    const paid = tx(-21420, "Card payment");
    const unrelated = tx(-956, "CARD 4411 SG5RF2145");
    expect(matchesTransactionSearch(paid, "214")).toBe(true);
    // The amount predicate is an OR beside text, not a mode switch, so the
    // digits inside a payment reference still match as text.
    expect(matchesTransactionSearch(unrelated, "214")).toBe(true);
  });

  it("text search over name, partner and reference is unchanged", () => {
    const t = tx(-500, "REWE Filiale", { partner: "Rewe GmbH", reference: "INV-77" });
    expect(matchesTransactionSearch(t, "rewe")).toBe(true);
    expect(matchesTransactionSearch(t, "GMBH")).toBe(true);
    expect(matchesTransactionSearch(t, "inv-77")).toBe(true);
    expect(matchesTransactionSearch(t, "billa")).toBe(false);
    // description is not searched here (the Transactions page does that).
    expect(matchesTransactionSearch({ ...t, description: "billa" }, "billa")).toBe(false);
  });

  it("a positive File amount typed in finds the negative transaction that paid it", () => {
    expect(matchesTransactionSearch(tx(-21420), "214,20")).toBe(true);
  });
});

describe("one predicate, no copies", () => {
  const repoRoot = path.resolve(__dirname, "../../../..");
  const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

  it.each([
    "components/files/connect-transaction-dialog.tsx",
    "components/files/connect-transaction-overlay.tsx",
    "functions/src/matching/findTransactionMatches.ts",
  ])("%s filters through matchesTransactionSearch and keeps no copy", (file) => {
    const src = read(file);
    expect(src).toMatch(/matchesTransactionSearch/);
    expect(src).not.toMatch(/reference\.includes\(/);
  });
});
