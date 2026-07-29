/**
 * Characterization tests — BMD NTCS export (functions/src/bmd-export/).
 *
 * Written to pin the CURRENT domain behavior before the rewrite. Every
 * assertion captures what the code does today, including quirks that look
 * like bugs — those are marked with "characterization:" comments and must
 * survive the port unchanged.
 *
 * Three layers:
 *   1. Pure CSV/format helpers (bmdCsvGenerators.ts) — exact output strings.
 *   2. requestBmdExport callable via the https-shim `.run()` convention.
 *   3. processBmdExportOnCreate trigger end-to-end on the shim stack:
 *      Firestore seed → bmdExports doc → ZIP in the memory blob store,
 *      unpacked and byte-checked (BOM, manifest, CSVs, belege/).
 *
 * Dates are seeded at 12:00 UTC — formatBmdDate uses LOCAL date parts, so
 * midday keeps the calendar day stable for any sane host timezone.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import * as unzipper from "unzipper";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim, __registeredTriggers } from "./trigger-shim";
import { getStorage, _resetStorageForTests } from "./storage-shim";
import { waitFor } from "./test-helpers";

// REAL application code, unmodified:
import {
  NO_RECEIPT_SACHKONTO_MAP,
  formatBmdDate,
  formatBmdAmount,
  escapeBmdCsv,
  createMatchcode,
  generatePersonenkontoNumber,
  generatePersonenkontenCsv,
  generateBuchungenCsv,
  generateFileMapping,
  PartnerAccountIndex,
  PartnerForExport,
  TransactionForExport,
  FileForExport,
} from "../bmd-export/bmdCsvGenerators";
import { requestBmdExportCallable } from "../bmd-export/requestBmdExport";
import "../bmd-export/processBmdExportQueue";

const db = getFirestore();
const USER = "stefan-test";

const T = (iso: string) => Timestamp.fromDate(new Date(iso));

const BUCHUNGEN_HEADER =
  "satzart;konto;gkto;belegnr;buchdat;belegdat;betrag;bucod;steuer;mwst;text;extbelegnr;symbol;uidnr";
const PERSONEN_HEADER =
  "konto;name;strasse;plz;ort;land;uidnr;telefon;email;iban;matchcode";

/** Minimal transaction for the generator layer; date defaults to 2026-03-15. */
function tx(over: Partial<TransactionForExport> & { amount: number }): TransactionForExport {
  return { id: "t1", date: T("2026-03-15T12:00:00Z"), ...over };
}

function call(data: unknown, auth?: { uid: string; token?: Record<string, unknown> }) {
  return requestBmdExportCallable.run({ data, auth } as never);
}

beforeAll(() => {
  // Deterministic root-relative download URLs from the buildDownloadUrl shim.
  delete process.env.FIBUKI_PUBLIC_URL;
});

beforeEach(async () => {
  // Let fire-and-forget writes from the previous test (usage logs) land
  // BEFORE the reset, so they can't bleed into this test.
  await new Promise((r) => setTimeout(r, 20));
  await __resetFirestoreShim();
  __resetTriggerShim();
  process.env.FIBUKI_STORAGE = "memory";
  _resetStorageForTests(); // fresh empty memory blob store per test
});

/* ------------------------------------------------------------------ */
/* 1. Pure helpers                                                     */
/* ------------------------------------------------------------------ */

describe("bmd characterization: formatBmdDate", () => {
  it("formats Timestamps as YYYYMMDD with zero padding", () => {
    expect(formatBmdDate(T("2026-03-05T12:00:00Z"))).toBe("20260305");
    expect(formatBmdDate(T("2026-11-03T12:00:00Z"))).toBe("20261103");
  });

  it("accepts plain Date objects", () => {
    expect(formatBmdDate(new Date(2026, 0, 9))).toBe("20260109");
  });

  it("returns empty string for undefined", () => {
    expect(formatBmdDate(undefined)).toBe("");
  });
});

describe("bmd characterization: formatBmdAmount", () => {
  it("converts cents to euros with comma separator", () => {
    expect(formatBmdAmount(12000)).toBe("120,00");
    expect(formatBmdAmount(1)).toBe("0,01");
    expect(formatBmdAmount(123456)).toBe("1234,56");
  });

  it("drops the sign entirely — direction is carried by bucod, not betrag", () => {
    expect(formatBmdAmount(-12000)).toBe("120,00");
    expect(formatBmdAmount(-1)).toBe("0,01");
  });

  it("renders missing amounts as 0,00", () => {
    expect(formatBmdAmount(undefined)).toBe("0,00");
    expect(formatBmdAmount(null as unknown as undefined)).toBe("0,00");
    expect(formatBmdAmount(0)).toBe("0,00");
  });

  it("does not use thousands separators", () => {
    // characterization: BMD gets "12345,67", never "12.345,67"
    expect(formatBmdAmount(1234567)).toBe("12345,67");
  });
});

describe("bmd characterization: escapeBmdCsv", () => {
  it("passes plain values through unquoted", () => {
    expect(escapeBmdCsv("plain")).toBe("plain");
    expect(escapeBmdCsv(42)).toBe("42");
  });

  it("quotes only on semicolon, double quote, or newline", () => {
    expect(escapeBmdCsv("a;b")).toBe('"a;b"');
    expect(escapeBmdCsv('say "hi"')).toBe('"say ""hi"""');
    expect(escapeBmdCsv("line1\nline2")).toBe('"line1\nline2"');
    // characterization: commas are NOT quoted (separator is ;), and
    // umlauts pass through raw — encoding is left to the UTF-8 BOM.
    expect(escapeBmdCsv("a,b")).toBe("a,b");
    expect(escapeBmdCsv("Müller & Söhne")).toBe("Müller & Söhne");
  });

  it("renders null/undefined as empty field", () => {
    expect(escapeBmdCsv(null)).toBe("");
    expect(escapeBmdCsv(undefined)).toBe("");
  });
});

describe("bmd characterization: createMatchcode", () => {
  it("uppercases and strips everything outside A-Z0-9", () => {
    expect(createMatchcode("Hetzner Online GmbH")).toBe("HETZNERONLINEGMBH");
    expect(createMatchcode("123 GmbH")).toBe("123GMBH");
  });

  it("drops umlauts instead of transliterating, but ß becomes SS", () => {
    // characterization: preserves current behavior — Ü/Ö/Ä are removed
    // outright (MÜLLER → MLLER), while ß survives because
    // "ß".toUpperCase() === "SS" happens BEFORE the strip. Looks buggy
    // (inconsistent transliteration) but must survive the port unchanged.
    expect(createMatchcode("Müller & Söhne KG")).toBe("MLLERSHNEKG");
    expect(createMatchcode("Straße")).toBe("STRASSE");
  });

  it("truncates to 20 chars and handles missing names", () => {
    expect(createMatchcode("Ärzte ohne Grenzen Österreich")).toBe("RZTEOHNEGRENZENSTERR");
    expect(createMatchcode(undefined)).toBe("");
  });
});

describe("bmd characterization: generatePersonenkontoNumber", () => {
  it("assigns sequential indices on a shared counter across both bases", () => {
    const idx: PartnerAccountIndex = new Map();
    expect(generatePersonenkontoNumber("p1", true, idx)).toBe("200001");
    // characterization: the index counter is shared between Kreditoren and
    // Debitoren, so the first Debitor is 300002, not 300001.
    expect(generatePersonenkontoNumber("p2", false, idx)).toBe("300002");
    expect(generatePersonenkontoNumber("p1", true, idx)).toBe("200001"); // stable
  });

  it("gives the SAME partner different numbers per direction", () => {
    // characterization: preserves current behavior — a partner queried once
    // as Kreditor and once as Debitor keeps one index but flips the base,
    // so the same partner appears as 200001 AND 300001. Looks buggy but
    // must survive the port unchanged.
    const idx: PartnerAccountIndex = new Map();
    expect(generatePersonenkontoNumber("p1", true, idx)).toBe("200001");
    expect(generatePersonenkontoNumber("p1", false, idx)).toBe("300001");
  });
});

/* ------------------------------------------------------------------ */
/* 2. Personenkonten CSV                                               */
/* ------------------------------------------------------------------ */

describe("bmd characterization: generatePersonenkontenCsv", () => {
  const fullPartner: PartnerForExport = {
    id: "p-hetzner",
    name: "Hetzner Online GmbH",
    street: "Industriestr. 25",
    postalCode: "91710",
    city: "Gunzenhausen",
    country: "de",
    vatId: "DE812871812",
    ibans: ["DE12 5001 0517 0648 4898 90", "DE99 0000 0000 0000 0000 00"],
    email: "billing@hetzner.com",
    phone: "+49 9831 5050",
    isKreditor: true,
  };

  it("emits the exact header and a fully populated Kreditor row", () => {
    const csv = generatePersonenkontenCsv([fullPartner], new Map());
    const lines = csv.split("\n");
    expect(lines[0]).toBe(PERSONEN_HEADER);
    // characterization: only the FIRST iban is exported, kept verbatim
    // (spaces included); country is uppercased.
    expect(lines[1]).toBe(
      "200001;Hetzner Online GmbH;Industriestr. 25;91710;Gunzenhausen;DE;DE812871812;+49 9831 5050;billing@hetzner.com;DE12 5001 0517 0648 4898 90;HETZNERONLINEGMBH",
    );
    expect(lines).toHaveLength(2);
  });

  it("defaults country to AT and truncates 'Austria' to 'AU'", () => {
    const csv = generatePersonenkontenCsv(
      [
        { id: "p1", name: "A", isKreditor: true },
        { id: "p2", name: "B", country: "Austria", isKreditor: false },
      ],
      new Map(),
    );
    const lines = csv.split("\n");
    expect(lines[1]).toBe("200001;A;;;;AT;;;;;A");
    // characterization: preserves current behavior — country is naively
    // substring(0,2)'d, so a spelled-out "Austria" exports as "AU"
    // (Australia's ISO code). Looks buggy but must survive the port.
    expect(lines[2]).toBe("300002;B;;;;AU;;;;;B");
  });

  it("truncates name to 50 chars and quotes semicolons in fields", () => {
    const longName = "X".repeat(60);
    const csv = generatePersonenkontenCsv(
      [
        { id: "p1", name: longName, isKreditor: true },
        { id: "p2", name: "Foo; Bar GmbH", isKreditor: true },
      ],
      new Map(),
    );
    const lines = csv.split("\n");
    // name capped at 50; matchcode capped at 20
    expect(lines[1]).toBe(`200001;${"X".repeat(50)};;;;AT;;;;;${"X".repeat(20)}`);
    expect(lines[2]).toBe('200002;"Foo; Bar GmbH";;;;AT;;;;;FOOBARGMBH');
  });
});

/* ------------------------------------------------------------------ */
/* 3. Buchungen CSV — standard path                                    */
/* ------------------------------------------------------------------ */

describe("bmd characterization: generateBuchungenCsv standard path", () => {
  it("emits the exact header and a full expense row (bucod 1, ER, gkto 7000)", () => {
    const files = new Map<string, FileForExport>([
      ["f1", { id: "f1", fileName: "rechnung-42.pdf", extractedDate: T("2026-03-10T12:00:00Z") }],
    ]);
    const csv = generateBuchungenCsv(
      [
        tx({
          amount: -12000,
          partnerId: "p-hetzner",
          partnerName: "Hetzner Online GmbH",
          vatId: "DE812871812",
          fileIds: ["f1"],
        }),
      ],
      files,
      new Map(),
    );
    const lines = csv.split("\n");
    expect(lines[0]).toBe(BUCHUNGEN_HEADER);
    // belegdat comes from the file's extractedDate, betrag is unsigned,
    // default VAT 20% computed from gross (12000 * 20/120 = 2000).
    expect(lines[1]).toBe(
      "0;200001;7000;2026000001;20260315;20260310;120,00;1;20,00;20;Hetzner Online GmbH;rechnung-42.pdf;ER;DE812871812",
    );
  });

  it("books income against gkto 4000 with bucod 2 / AR and the Debitor fallback konto", () => {
    const csv = generateBuchungenCsv(
      [tx({ amount: 250000, name: "Payout", partner: "STRIPE PAYMENTS" })],
      new Map(),
      new Map(),
    );
    // no partnerId → fallback 300001; displayName prefers raw bank partner
    // over tx name; VAT: round(250000 * 20/120) = 41667.
    expect(csv.split("\n")[1]).toBe(
      "0;300001;4000;2026000001;20260315;20260315;2500,00;2;416,67;20;STRIPE PAYMENTS;;AR;",
    );
  });

  it("display name precedence: partnerName > partner > name > empty", () => {
    const rows = generateBuchungenCsv(
      [
        tx({ id: "a", amount: -100, partnerName: "Resolved", partner: "Raw", name: "Name" }),
        tx({ id: "b", amount: -100, partner: "Raw", name: "Name" }),
        tx({ id: "c", amount: -100, name: "Name" }),
        tx({ id: "d", amount: -100 }),
      ],
      new Map(),
      new Map(),
    ).split("\n");
    expect(rows[1].split(";")[10]).toBe("Resolved");
    expect(rows[2].split(";")[10]).toBe("Raw");
    expect(rows[3].split(";")[10]).toBe("Name");
    expect(rows[4].split(";")[10]).toBe("");
  });

  it("rounds VAT half-up from the gross amount", () => {
    // 999 * 20 / 120 = 166.5 → Math.round → 167 cents
    const csv = generateBuchungenCsv([tx({ amount: -999 })], new Map(), new Map());
    expect(csv.split("\n")[1].split(";")[8]).toBe("1,67");
  });

  it("honors explicit vatRate and vatAmount, including vatAmount 0", () => {
    const rows = generateBuchungenCsv(
      [
        tx({ id: "a", amount: -11000, vatRate: 10 }), // round(11000*10/110) = 1000
        tx({ id: "b", amount: -11000, vatAmount: 1234 }),
        tx({ id: "c", amount: -11000, vatRate: 0 }),
        tx({ id: "d", amount: -11000, vatAmount: 0 }), // ?? keeps the explicit 0
      ],
      new Map(),
      new Map(),
    ).split("\n");
    expect(rows[1]).toContain(";110,00;1;10,00;10;");
    expect(rows[2]).toContain(";110,00;1;12,34;20;");
    expect(rows[3]).toContain(";110,00;1;0,00;0;");
    expect(rows[4]).toContain(";110,00;1;0,00;20;");
  });

  it("treats amount 0 as income (bucod 2, AR, Debitor fallback)", () => {
    // characterization: preserves current behavior — `amount < 0` decides
    // expense, so a zero-amount booking exports as income/AR/300001.
    const csv = generateBuchungenCsv([tx({ amount: 0, name: "Zero" })], new Map(), new Map());
    expect(csv.split("\n")[1]).toBe(
      "0;300001;4000;2026000001;20260315;20260315;0,00;2;0,00;20;Zero;;AR;",
    );
  });

  it("fallback Kreditor konto 200001 collides with the first indexed partner", () => {
    // characterization: preserves current behavior — a partnerless expense
    // uses KREDITOR_ACCOUNT_BASE + 1 = 200001, the SAME number the first
    // indexed partner receives. Two unrelated counterparties share one
    // Personenkonto. Looks buggy but must survive the port unchanged.
    const csv = generateBuchungenCsv(
      [
        tx({ id: "a", amount: -100, partnerId: "p1", partnerName: "Real Partner" }),
        tx({ id: "b", amount: -100, name: "No partner" }),
      ],
      new Map(),
      new Map(),
    );
    const rows = csv.split("\n");
    expect(rows[1].split(";")[1]).toBe("200001");
    expect(rows[2].split(";")[1]).toBe("200001");
  });

  it("prefixes belegnr with each transaction's OWN year on one shared counter", () => {
    // characterization: preserves current behavior — the counter is global
    // but the year prefix is per-row, so a year boundary yields
    // 2025000001, 2026000002 (numbering does not restart per year).
    const rows = generateBuchungenCsv(
      [
        tx({ id: "a", amount: -1000, date: T("2025-12-31T12:00:00Z") }),
        tx({ id: "b", amount: -2000, date: T("2026-01-01T12:00:00Z") }),
      ],
      new Map(),
      new Map(),
    ).split("\n");
    expect(rows[1].split(";")[3]).toBe("2025000001");
    expect(rows[2].split(";")[3]).toBe("2026000002");
  });

  it("respects startBelegnr", () => {
    const csv = generateBuchungenCsv([tx({ amount: -100 })], new Map(), new Map(), 42);
    expect(csv.split("\n")[1].split(";")[3]).toBe("2026000042");
  });

  it("takes belegdat from the FIRST file only — a dateless first file wins over a dated second", () => {
    // characterization: preserves current behavior — only fileIds[0] is
    // consulted for extractedDate; if it has none, falls back to the
    // transaction date even when a later file carries one.
    const files = new Map<string, FileForExport>([
      ["f1", { id: "f1", fileName: "a.pdf" }],
      ["f2", { id: "f2", fileName: "b.pdf", extractedDate: T("2026-01-05T12:00:00Z") }],
    ]);
    const row = generateBuchungenCsv(
      [tx({ amount: -100, fileIds: ["f1", "f2"] })],
      files,
      new Map(),
    ).split("\n")[1];
    const cols = row.split(";");
    expect(cols[5]).toBe("20260315"); // tx date, NOT 20260105
    expect(cols[11]).toBe("a.pdf, b.pdf"); // extbelegnr joins with ", "
  });

  it("drops unknown fileIds from extbelegnr and truncates it to 50 chars", () => {
    const files = new Map<string, FileForExport>([
      ["f1", { id: "f1", fileName: "A".repeat(40) + ".pdf" }],
      ["f2", { id: "f2", fileName: "B".repeat(40) + ".pdf" }],
    ]);
    const rows = generateBuchungenCsv(
      [
        tx({ id: "a", amount: -100, fileIds: ["missing-file"] }),
        tx({ id: "b", amount: -100, fileIds: ["f1", "f2"] }),
      ],
      files,
      new Map(),
    ).split("\n");
    expect(rows[1].split(";")[11]).toBe(""); // missing file doc → empty ref
    const joined = "A".repeat(40) + ".pdf, " + "B".repeat(40) + ".pdf";
    expect(rows[2].split(";")[11]).toBe(joined.substring(0, 50));
  });

  it("truncates text to 75 chars and uidnr to 20 chars", () => {
    const row = generateBuchungenCsv(
      [tx({ amount: -100, name: "X".repeat(80), vatId: "ATU123456789012345678999" })],
      new Map(),
      new Map(),
    ).split("\n")[1];
    const cols = row.split(";");
    expect(cols[10]).toBe("X".repeat(75));
    expect(cols[13]).toBe("ATU12345678901234567");
  });

  it("quotes booking text containing semicolons", () => {
    const row = generateBuchungenCsv(
      [tx({ amount: -100, name: "Foo; Bar" })],
      new Map(),
      new Map(),
    ).split("\n")[1];
    expect(row).toContain(';"Foo; Bar";');
  });
});

/* ------------------------------------------------------------------ */
/* 4. Buchungen CSV — no-receipt category path                         */
/* ------------------------------------------------------------------ */

describe("bmd characterization: generateBuchungenCsv no-receipt categories", () => {
  function catTx(templateId: string, amount: number, over: Partial<TransactionForExport> = {}) {
    return tx({
      amount,
      name: "Cat",
      noReceiptCategoryId: "cat-1",
      noReceiptCategoryTemplateId: templateId,
      ...over,
    });
  }

  it("books a bank-fees expense on Sachkonto 7780 with empty gkto, 0% VAT, BK symbol", () => {
    const csv = generateBuchungenCsv([catTx("bank-fees", -1050, { name: "N26 fee" })], new Map(), new Map());
    // konto is the Sachkonto, gkto stays empty (BMD assigns the bank side),
    // text is "<category name>: <display name>".
    expect(csv.split("\n")[1]).toBe(
      "0;7780;;2026000001;20260315;20260315;10,50;1;0,00;0;Bankspesen: N26 fee;;BK;",
    );
  });

  it("maps directional Sachkonten per category", () => {
    const rows = generateBuchungenCsv(
      [
        catTx("interest", -500, { id: "a" }), // expense 7810
        catTx("interest", 500, { id: "b" }), // income 8100
        catTx("internal-transfers", -900, { id: "c" }), // 2800 both ways
        catTx("internal-transfers", 900, { id: "d" }),
        catTx("taxes-government", -700, { id: "e" }), // 3520
        catTx("payroll", -300000, { id: "f" }), // 6200 / GH
        catTx("private-personal", 800, { id: "g" }), // 9600 / PR
      ],
      new Map(),
      new Map(),
    ).split("\n");
    expect(rows[1].split(";").slice(1, 3)).toEqual(["7810", ""]);
    expect(rows[2].split(";").slice(1, 3)).toEqual(["8100", ""]);
    expect(rows[3].split(";")[1]).toBe("2800");
    expect(rows[4].split(";")[1]).toBe("2800");
    expect(rows[5].split(";")[1]).toBe("3520");
    expect(rows[6].split(";")[1]).toBe("6200");
    expect(rows[6].split(";")[12]).toBe("GH");
    expect(rows[7].split(";")[1]).toBe("9600");
    expect(rows[7].split(";")[12]).toBe("PR");
  });

  it("falls back to 4000 for income on an expense-only category, keeping its symbol", () => {
    // characterization: preserves current behavior — bank-fees has no income
    // Sachkonto, so an incoming fee refund lands on generic revenue 4000 but
    // still carries the BK symbol. Looks questionable but must survive.
    const csv = generateBuchungenCsv([catTx("bank-fees", 500, { name: "refund" })], new Map(), new Map());
    expect(csv.split("\n")[1]).toBe(
      "0;4000;;2026000001;20260315;20260315;5,00;2;0,00;0;Bankspesen: refund;;BK;",
    );
  });

  it("receipt-lost keeps VAT (default 20%) unlike all other categories", () => {
    const csv = generateBuchungenCsv([catTx("receipt-lost", -6000, { name: "Lost" })], new Map(), new Map());
    expect(csv.split("\n")[1]).toBe(
      "0;7000;;2026000001;20260315;20260315;60,00;1;10,00;20;Eigenbeleg: Lost;;ER;",
    );
  });

  it("receipt-lost income uses Sachkonto 4000 but keeps the ER symbol", () => {
    // characterization: preserves current behavior — the category symbol
    // "ER" (Eingangsrechnung) is used even for INCOME receipt-lost rows;
    // vatRate 10 is honored: round(11000*10/110) = 1000.
    const csv = generateBuchungenCsv(
      [catTx("receipt-lost", 11000, { name: "Found money", vatRate: 10 })],
      new Map(),
      new Map(),
    );
    expect(csv.split("\n")[1]).toBe(
      "0;4000;;2026000001;20260315;20260315;110,00;2;10,00;10;Eigenbeleg: Found money;;ER;",
    );
  });

  it("skips zero-value transactions but still consumes a Belegnummer", () => {
    // characterization: preserves current behavior — the zero-value row is
    // dropped from the CSV yet the counter advances, leaving a numbering
    // gap (…001, …003). Looks buggy but must survive the port unchanged.
    const rows = generateBuchungenCsv(
      [
        tx({ id: "a", amount: -100, name: "first" }),
        catTx("zero-value", 0, { id: "b" }),
        tx({ id: "c", amount: -200, name: "third" }),
      ],
      new Map(),
      new Map(),
    ).split("\n");
    expect(rows).toHaveLength(3); // header + 2 rows
    expect(rows[1].split(";")[3]).toBe("2026000001");
    expect(rows[2].split(";")[3]).toBe("2026000003");
  });

  it("a categorized transaction WITH files takes the standard path instead", () => {
    // characterization: files win over the no-receipt category — the row
    // gets a Personenkonto, gkto 7000 and default 20% VAT, not the
    // category Sachkonto with 0%.
    const files = new Map<string, FileForExport>([["f1", { id: "f1", fileName: "beleg.pdf" }]]);
    const csv = generateBuchungenCsv(
      [catTx("bank-fees", -1050, { name: "Fee with receipt", fileIds: ["f1"] })],
      files,
      new Map(),
    );
    expect(csv.split("\n")[1]).toBe(
      "0;200001;7000;2026000001;20260315;20260315;10,50;1;1,75;20;Fee with receipt;beleg.pdf;ER;",
    );
  });

  it("an unknown templateId falls through to the standard path", () => {
    const csv = generateBuchungenCsv(
      [catTx("not-a-real-category", -1000, { name: "Odd" })],
      new Map(),
      new Map(),
    );
    expect(csv.split("\n")[1]).toBe(
      "0;200001;7000;2026000001;20260315;20260315;10,00;1;1,67;20;Odd;;ER;",
    );
  });

  it("zero-value mapping stays all-null in the Sachkonto table", () => {
    expect(NO_RECEIPT_SACHKONTO_MAP["zero-value"]).toEqual({
      expense: null,
      income: null,
      symbol: "",
      name: "",
    });
  });
});

/* ------------------------------------------------------------------ */
/* 5. generateFileMapping                                              */
/* ------------------------------------------------------------------ */

describe("bmd characterization: generateFileMapping", () => {
  it("advances the counter for every transaction but maps only those with files", () => {
    const mapping = generateFileMapping([
      tx({ id: "a", amount: -100, fileIds: ["f1"] }),
      tx({ id: "b", amount: -200 }), // no files — consumes a number anyway
      tx({ id: "c", amount: -300, fileIds: ["f2", "f3"] }),
    ]);
    expect(mapping.size).toBe(2);
    expect(mapping.get("a")).toEqual({ belegnr: "2026000001", fileIds: ["f1"] });
    expect(mapping.get("c")).toEqual({ belegnr: "2026000003", fileIds: ["f2", "f3"] });
  });

  it("maps a zero-value transaction with files even though buchungen skips it", () => {
    // characterization: preserves current behavior — generateFileMapping has
    // no zero-value skip, so a zero-value tx WITH files gets a belegnr that
    // never appears in buchungen.csv. Looks buggy but must survive.
    const mapping = generateFileMapping([
      tx({ id: "z", amount: 0, noReceiptCategoryTemplateId: "zero-value", fileIds: ["f1"] }),
    ]);
    expect(mapping.get("z")).toEqual({ belegnr: "2026000001", fileIds: ["f1"] });
  });

  it("respects startBelegnr", () => {
    const mapping = generateFileMapping([tx({ id: "a", amount: -100, fileIds: ["f1"] })], 7);
    expect(mapping.get("a")!.belegnr).toBe("2026000007");
  });
});

/* ------------------------------------------------------------------ */
/* 6. requestBmdExport callable                                        */
/* ------------------------------------------------------------------ */

describe("bmd characterization: requestBmdExport callable via https-shim", () => {
  const validReq = {
    dateFrom: "2026-01-01",
    dateTo: "2026-12-31",
    onlyWithFiles: true,
    includeFiles: true,
  };

  it("rejects unauthenticated calls through the unmodified createCallable wrapper", async () => {
    await expect(call(validReq)).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("rejects unparseable dates and inverted ranges as invalid-argument", async () => {
    await expect(
      call({ ...validReq, dateFrom: "not-a-date" }, { uid: USER }),
    ).rejects.toMatchObject({ code: "invalid-argument" });
    await expect(
      call({ ...validReq, dateFrom: "2026-12-31", dateTo: "2026-01-01" }, { uid: USER }),
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("allows dateFrom === dateTo (strict > comparison)", async () => {
    const res = await call({ ...validReq, dateFrom: "2026-06-01", dateTo: "2026-06-01" }, { uid: USER });
    expect(res.success).toBe(true);
  });

  it("creates a pending export doc with defaulted flags, zeroed counts and retry config", async () => {
    const res = await call(
      { dateFrom: "2026-01-01", dateTo: "2026-03-31" }, // flags omitted
      { uid: USER },
    );
    expect(res.success).toBe(true);

    const doc = (await db.collection("bmdExports").doc(res.exportId).get()).data()!;
    expect(doc.userId).toBe(USER);
    expect(doc.status).toBe("pending");
    expect(doc.onlyWithFiles).toBe(true); // ?? true default
    expect(doc.includeFiles).toBe(true); // ?? true default
    expect((doc.dateFrom as Timestamp).toDate().toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect((doc.dateTo as Timestamp).toDate().toISOString()).toBe("2026-03-31T00:00:00.000Z");
    expect(doc.progress).toEqual({ phase: "collecting", current: 0, total: 0 });
    expect(doc.counts).toEqual({ transactions: 0, files: 0, partners: 0, kreditoren: 0, debitoren: 0 });
    expect(doc.retryCount).toBe(0);
    expect(doc.maxRetries).toBe(3);
    expect(doc.createdAt).toBeInstanceOf(Timestamp);
  });

  it("returns the existing export instead of creating a second one while pending", async () => {
    const first = await call(validReq, { uid: USER });
    // no drainTriggers between calls — the first export is still pending
    const second = await call(
      { ...validReq, dateFrom: "2025-01-01", dateTo: "2025-12-31" },
      { uid: USER },
    );
    expect(second.exportId).toBe(first.exportId);
    const all = await db.collection("bmdExports").get();
    expect(all.size).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 7. processBmdExportOnCreate — end-to-end                            */
/* ------------------------------------------------------------------ */

async function openZip(storagePath: string) {
  const [buf] = await getStorage().bucket().file(storagePath).download();
  const dir = await unzipper.Open.buffer(buf);
  const entry = async (name: string) => {
    const f = dir.files.find((f) => f.path === name);
    expect(f, `zip entry ${name}`).toBeDefined();
    return (await f!.buffer()).toString("utf8");
  };
  return { buf, dir, entry };
}

describe("bmd characterization: processBmdExportOnCreate end-to-end", () => {
  it("registered the real trigger on bmdExports/{exportId}", () => {
    expect(__registeredTriggers()).toContainEqual({
      type: "created",
      document: "bmdExports/{exportId}",
    });
  });

  it("full chain: callable → trigger → ZIP with manifest, BOM'd CSVs and belege", async () => {
    // Partner WITH email + phone — pins that the queue never maps them.
    await db.collection("partners").doc("p-hetzner").set({
      userId: USER,
      name: "Hetzner Online GmbH",
      street: "Industriestr. 25",
      postalCode: "91710",
      city: "Gunzenhausen",
      country: "de",
      vatId: "DE812871812",
      ibans: ["DE12 5001 0517 0648 4898 90"],
      email: "billing@hetzner.com",
      phone: "+49 9831 5050",
    });

    // Receipt file doc + blob (umlaut name pins the ZIP-entry sanitizer).
    await db.collection("files").doc("f1").set({
      userId: USER,
      fileName: "Rechnung März.pdf",
      extractedDate: T("2026-03-10T12:00:00Z"),
      storagePath: "users/stefan-test/files/f1.pdf",
    });
    await getStorage().bucket().file("users/stefan-test/files/f1.pdf").save(Buffer.from("PDFDATA"));

    // t1: expense with partner + file. t2: no-receipt interest income.
    await db.collection("transactions").doc("t1").set({
      userId: USER,
      date: T("2026-03-15T12:00:00Z"),
      amount: -12000,
      name: "HETZNER",
      partnerId: "p-hetzner",
      fileIds: ["f1"],
    });
    await db.collection("transactions").doc("t2").set({
      userId: USER,
      date: T("2026-06-01T12:00:00Z"),
      amount: 1234,
      name: "Habenzinsen",
      noReceiptCategoryId: "cat-interest",
      noReceiptCategoryTemplateId: "interest",
    });
    // t3: incomplete (no files, no category) — filtered by onlyWithFiles.
    await db.collection("transactions").doc("t3").set({
      userId: USER,
      date: T("2026-05-01T12:00:00Z"),
      amount: -500,
      name: "Incomplete",
    });
    // t4: out of range. t5: other user.
    await db.collection("transactions").doc("t4").set({
      userId: USER,
      date: T("2027-05-01T12:00:00Z"),
      amount: -500,
      fileIds: ["f1"],
    });
    await db.collection("transactions").doc("t5").set({
      userId: "someone-else",
      date: T("2026-05-01T12:00:00Z"),
      amount: -500,
      fileIds: ["f1"],
    });
    await drainTriggers();

    const res = await call(
      { dateFrom: "2026-01-01", dateTo: "2026-12-31", onlyWithFiles: true, includeFiles: true },
      { uid: USER },
    );
    const exportRef = db.collection("bmdExports").doc(res.exportId);
    await waitFor(async () => (await exportRef.get()).data()!.status === "completed");

    const doc = (await exportRef.get()).data()!;
    expect(doc.progress.phase).toBe("complete");
    expect(doc.counts).toEqual({ transactions: 2, files: 1, partners: 1, kreditoren: 1, debitoren: 0 });
    expect(doc.startedAt).toBeInstanceOf(Timestamp);
    expect(doc.completedAt).toBeInstanceOf(Timestamp);
    expect(doc.zipSize).toBeGreaterThan(0);

    // Storage path is bmd-exports/{userId}/{exportId}/fibuki-bmd-export-{UTC date}.zip
    const today = new Date().toISOString().split("T")[0];
    expect(doc.storagePath).toBe(
      `bmd-exports/${USER}/${res.exportId}/fibuki-bmd-export-${today}.zip`,
    );
    // Selfhost buildDownloadUrl shim: root-relative host download route.
    expect(doc.downloadUrl).toBe(`/__storage/download/${doc.storagePath}`);

    // expiresAt = now + 7 days (BMD_EXPORT_EXPIRY_DAYS)
    const expectedExpiry = new Date();
    expectedExpiry.setDate(expectedExpiry.getDate() + 7);
    expect(Math.abs((doc.expiresAt as Timestamp).toMillis() - expectedExpiry.getTime())).toBeLessThan(60_000);

    // ZIP object metadata
    const [meta] = await getStorage().bucket().file(doc.storagePath).getMetadata();
    expect(meta.contentType).toBe("application/zip");
    expect(meta.metadata!.userId).toBe(USER);
    expect(meta.metadata!.exportId).toBe(res.exportId);
    expect(meta.metadata!.format).toBe("BMD-NTCS");
    expect(meta.metadata!.firebaseStorageDownloadTokens).toBeTruthy();
    expect(Number(meta.size)).toBe(doc.zipSize);

    // ZIP contents
    const zip = await openZip(doc.storagePath);
    expect(zip.dir.files.map((f) => f.path).sort()).toEqual([
      "belege/f1_Rechnung_M_rz.pdf", // sanitizer: space and ä both become _
      "buchungen.csv",
      "manifest.json",
      "personenkonten.csv",
    ]);

    const manifest = JSON.parse(await zip.entry("manifest.json"));
    expect(manifest.version).toBe("1.0");
    expect(manifest.format).toBe("BMD-NTCS");
    expect(manifest.userId).toBe(USER);
    expect(manifest.exportId).toBe(res.exportId);
    expect(manifest.dateRange).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(manifest.counts).toEqual({ transactions: 2, files: 1, partners: 1, kreditoren: 1, debitoren: 0 });
    expect(manifest.includesFiles).toBe(true);

    // Both CSVs are prefixed with a UTF-8 BOM for Excel.
    const personen = await zip.entry("personenkonten.csv");
    const buchungen = await zip.entry("buchungen.csv");
    expect(personen.charCodeAt(0)).toBe(0xfeff);
    expect(buchungen.charCodeAt(0)).toBe(0xfeff);

    // characterization: preserves current behavior — the queue's partner
    // mapping never copies email/phone from the partner doc, so telefon and
    // email columns are ALWAYS empty in real exports even though the CSV
    // generator supports them. Looks buggy but must survive the port.
    expect(personen.slice(1)).toBe(
      PERSONEN_HEADER +
        "\n" +
        "200001;Hetzner Online GmbH;Industriestr. 25;91710;Gunzenhausen;DE;DE812871812;;;DE12 5001 0517 0648 4898 90;HETZNERONLINEGMBH",
    );

    const buchungenLines = buchungen.slice(1).split("\n");
    expect(buchungenLines[0]).toBe(BUCHUNGEN_HEADER);
    expect(buchungenLines).toHaveLength(3);
    // Umlaut file name survives raw in extbelegnr; partner name resolved
    // through partnersMap; belegdat from the file's extractedDate.
    expect(buchungenLines).toContain(
      "0;200001;7000;2026000001;20260315;20260310;120,00;1;20,00;20;Hetzner Online GmbH;Rechnung März.pdf;ER;",
    );
    expect(buchungenLines).toContain(
      "0;8100;;2026000002;20260601;20260601;12,34;2;0,00;0;Zinsen: Habenzinsen;;BK;",
    );

    // Receipt blob is embedded verbatim.
    const belegEntry = zip.dir.files.find((f) => f.path === "belege/f1_Rechnung_M_rz.pdf")!;
    expect((await belegEntry.buffer()).toString("utf8")).toBe("PDFDATA");
  });

  it("onlyWithFiles keeps category-only txs, and includeFiles:false omits belege", async () => {
    // characterization: the onlyWithFiles filter checks noReceiptCategoryId
    // (NOT the templateId), so a tx with a category id but no templateId
    // passes the filter and then falls through to the STANDARD booking path.
    await db.collection("transactions").doc("t-ghost").set({
      userId: USER,
      date: T("2026-03-15T12:00:00Z"),
      amount: -5000,
      name: "Ghost payment",
      partnerId: "ghost", // partner doc does not exist
      noReceiptCategoryId: "custom-cat",
    });
    await drainTriggers();

    await db.collection("bmdExports").doc("exp-1").set({
      userId: USER,
      status: "pending",
      dateFrom: T("2026-01-01T00:00:00Z"),
      dateTo: T("2026-12-31T00:00:00Z"),
      onlyWithFiles: true,
      includeFiles: false,
      retryCount: 0,
      maxRetries: 3,
    });
    const exportRef = db.collection("bmdExports").doc("exp-1");
    await waitFor(async () => (await exportRef.get()).data()!.status === "completed");

    const doc = (await exportRef.get()).data()!;
    // Missing partner doc: counted in NO partner tallies, but the buchungen
    // row still allocates a Personenkonto number for the unknown partnerId.
    expect(doc.counts).toEqual({ transactions: 1, files: 0, partners: 0, kreditoren: 0, debitoren: 0 });

    const zip = await openZip(doc.storagePath);
    expect(zip.dir.files.map((f) => f.path).sort()).toEqual([
      "buchungen.csv",
      "manifest.json",
      "personenkonten.csv",
    ]); // no belege/ when includeFiles is false

    const manifest = JSON.parse(await zip.entry("manifest.json"));
    expect(manifest.includesFiles).toBe(false);

    const personen = await zip.entry("personenkonten.csv");
    expect(personen.slice(1)).toBe(PERSONEN_HEADER); // header only, no rows

    const buchungen = (await zip.entry("buchungen.csv")).slice(1).split("\n");
    // Standard path (no templateId): default 20% VAT, round(5000*20/120)=833.
    expect(buchungen).toEqual([
      BUCHUNGEN_HEADER,
      "0;200001;7000;2026000001;20260315;20260315;50,00;1;8,33;20;Ghost payment;;ER;",
    ]);
  });

  it("skips exports whose status is not pending", async () => {
    await db.collection("bmdExports").doc("exp-done").set({
      userId: USER,
      status: "completed",
      dateFrom: T("2026-01-01T00:00:00Z"),
      dateTo: T("2026-12-31T00:00:00Z"),
      onlyWithFiles: true,
      includeFiles: false,
    });
    await drainTriggers();

    const doc = (await db.collection("bmdExports").doc("exp-done").get()).data()!;
    expect(doc.status).toBe("completed");
    expect(doc.startedAt).toBeUndefined(); // processing never began
    expect(doc.storagePath).toBeUndefined();
  });

  it("marks the export failed (no retry) on a non-timeout error", async () => {
    // Unconfigured blob store → file.save throws during upload. The error
    // does not contain "Timeout", so retryCount stays 0 and status→failed.
    // FIBUKI_S3_ENDPOINT alone also selects the S3 backend, and the compose
    // CI profile exports it suite-wide — clear both, restore in finally.
    const prev = { store: process.env.FIBUKI_STORAGE, s3: process.env.FIBUKI_S3_ENDPOINT };
    delete process.env.FIBUKI_STORAGE;
    delete process.env.FIBUKI_S3_ENDPOINT;
    _resetStorageForTests();

    await db.collection("bmdExports").doc("exp-fail").set({
      userId: USER,
      status: "pending",
      dateFrom: T("2026-01-01T00:00:00Z"),
      dateTo: T("2026-12-31T00:00:00Z"),
      onlyWithFiles: true,
      includeFiles: false,
      retryCount: 0,
      maxRetries: 3,
    });
    const exportRef = db.collection("bmdExports").doc("exp-fail");
    try {
      await waitFor(async () => (await exportRef.get()).data()!.status === "failed");

      const doc = (await exportRef.get()).data()!;
      expect(doc.error).toContain("no blob store configured");
      expect(doc.retryCount).toBe(0); // only "Timeout" errors re-queue
      expect(doc.completedAt).toBeInstanceOf(Timestamp);
      expect(doc.downloadUrl).toBeUndefined();
    } finally {
      if (prev.store !== undefined) process.env.FIBUKI_STORAGE = prev.store;
      if (prev.s3 !== undefined) process.env.FIBUKI_S3_ENDPOINT = prev.s3;
      _resetStorageForTests();
    }
  });
});
