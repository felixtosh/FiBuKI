/**
 * updateSource merges, never overwrites, the source Partner's identity (#445)
 *
 * updateSource used to rewrite the source Partner's name, aliases and ibans
 * wholesale from the source's current values. Anything a pre-#380 merge folded
 * into that Partner — an alias, an old IBAN — was lost on the next source
 * edit, and its historical Transactions stopped matching. The sync must
 * union instead: the name only changes on an explicit rename (the displaced
 * name stays as an alias), aliases and IBANs only ever grow.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { store, createTestContext, createTestSource, createTestPartner } from "../../test/setup";

vi.mock("firebase-admin/firestore", () => ({
  FieldValue: {
    serverTimestamp: () => new Date(),
  },
  Timestamp: {
    now: () => new Date(),
    fromDate: (d: Date) => d,
  },
}));

vi.mock("../../utils/createCallable", () => ({
  createCallable: <TReq, TRes>(
    _config: { name: string },
    handler: (ctx: unknown, data: TReq) => Promise<TRes>
  ) => handler,
  HttpsError: class HttpsError extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
}));

import { updateSourceCallable } from "../updateSource";

const USER = "user-1";
const OLD_IBAN = "AT611904300234573201";
const NEW_IBAN = "AT026000000001349870";

type UpdateSourceHandler = (
  ctx: unknown,
  request: { sourceId: string; data: Record<string, unknown> }
) => Promise<{ success: boolean }>;

const updateSource = updateSourceCallable as unknown as UpdateSourceHandler;

function seedBankSource(): void {
  store.setDoc(
    "sources",
    "bank-1",
    createTestSource({
      userId: USER,
      name: "Erste Konto",
      accountKind: "checking",
      iban: OLD_IBAN,
      sourcePartnerId: "bank-partner",
    })
  );
  store.setDoc(
    "partners",
    "bank-partner",
    createTestPartner({
      userId: USER,
      name: "Erste Konto",
      identitySourceField: "source:bank-1",
      // Folded in by a merge before #380 refused them
      aliases: ["Erste Bank Giro", "Mein Gehaltskonto"],
      ibans: [OLD_IBAN],
    })
  );
}

function seedCardSource(): void {
  store.setDoc(
    "sources",
    "card-1",
    createTestSource({
      userId: USER,
      name: "Visa Karte",
      accountKind: "credit_card",
      iban: OLD_IBAN,
      cardBrand: "visa",
      cardLast4: "1234",
      sourcePartnerId: "card-partner",
    })
  );
  store.setDoc(
    "partners",
    "card-partner",
    createTestPartner({
      userId: USER,
      name: "Visa Karte",
      identitySourceField: "source:card-1",
      aliases: ["VISA", "VISA 1234", "VISA*1234", "Karte 1234"],
      ibans: [OLD_IBAN],
    })
  );
}

describe("updateSource merges the source Partner's identity", () => {
  beforeEach(() => {
    store.clear();
  });

  it("a pre-existing alias and IBAN survive an IBAN change", async () => {
    seedBankSource();

    await updateSource(createTestContext(USER), {
      sourceId: "bank-1",
      data: { iban: NEW_IBAN },
    });

    const partner = store.getDoc("partners", "bank-partner")!;
    expect(partner.aliases).toContain("Erste Bank Giro");
    expect(partner.aliases).toContain("Mein Gehaltskonto");
    expect(partner.ibans).toContain(OLD_IBAN);
    expect(partner.ibans).toContain(NEW_IBAN);
  });

  it("a replaced card keeps its old IBAN and old card aliases live", async () => {
    seedCardSource();

    await updateSource(createTestContext(USER), {
      sourceId: "card-1",
      data: { cardLast4: "5678" },
    });

    const partner = store.getDoc("partners", "card-partner")!;
    // The old card's identifiers keep matching its historical Transactions
    expect(partner.ibans).toContain(OLD_IBAN);
    expect(partner.aliases).toContain("VISA 1234");
    expect(partner.aliases).toContain("Karte 1234");
    // The new card is matchable too
    expect(partner.aliases).toContain("VISA 5678");
  });

  it("keeps the Partner's name on a non-rename update; the source's differing name becomes an alias", async () => {
    seedBankSource();
    // Pre-#380 merge survivor kept its own name, which differs from the source's
    store.setDoc(
      "partners",
      "bank-partner",
      createTestPartner({
        userId: USER,
        name: "Erste Bank",
        identitySourceField: "source:bank-1",
        aliases: [],
        ibans: [OLD_IBAN],
      })
    );

    await updateSource(createTestContext(USER), {
      sourceId: "bank-1",
      data: { iban: NEW_IBAN },
    });

    const partner = store.getDoc("partners", "bank-partner")!;
    expect(partner.name).toBe("Erste Bank");
    expect(partner.aliases).toContain("Erste Konto");
  });

  it("an explicit rename changes the name and keeps the displaced name as an alias", async () => {
    seedBankSource();

    await updateSource(createTestContext(USER), {
      sourceId: "bank-1",
      data: { name: "Neues Konto" },
    });

    const partner = store.getDoc("partners", "bank-partner")!;
    expect(partner.name).toBe("Neues Konto");
    expect(partner.aliases).toContain("Erste Konto");
    expect(partner.aliases).toContain("Erste Bank Giro");
    expect(partner.ibans).toContain(OLD_IBAN);
  });

  it("never duplicates an alias or an IBAN, and the name is not its own alias", async () => {
    seedCardSource();

    await updateSource(createTestContext(USER), {
      sourceId: "card-1",
      data: { cardLast4: "1234" },
    });

    const partner = store.getDoc("partners", "card-partner")!;
    const aliases = partner.aliases as string[];
    const ibans = partner.ibans as string[];
    expect(new Set(aliases).size).toBe(aliases.length);
    expect(new Set(ibans).size).toBe(ibans.length);
    expect(aliases).not.toContain(partner.name);
  });
});
