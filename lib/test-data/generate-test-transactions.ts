import { Timestamp } from "firebase/firestore";
import { SaleSupplyKind, Transaction, TransactionType } from "@/types/transaction";
import { TransactionSource } from "@/types/source";

/** How an Austrian bank export words each type, for the raw "Buchungsart" column (#136). */
const BANK_TYPE_WORDING: Record<TransactionType, string> = {
  direct_debit: "SEPA-Lastschrift",
  standing_order: "Dauerauftrag",
  transfer: "Überweisung",
  card: "Kartenzahlung",
};

export const TEST_SOURCE_ID = "test-source-dev";
// Placeholder user ID - will be replaced with actual user ID in test-data-ops.ts
const PLACEHOLDER_USER_ID = "__PLACEHOLDER__";

const TEST_SOURCE_IBAN = "DE89370400440532013000";

/**
 * Generate the test source (bank account)
 */
export function generateTestSource(): Omit<TransactionSource, "createdAt" | "updatedAt"> & {
  createdAt: Timestamp;
  updatedAt: Timestamp;
} {
  const now = Timestamp.now();
  return {
    id: TEST_SOURCE_ID,
    name: "Test Bank Account",
    accountKind: "bank_account",
    iban: TEST_SOURCE_IBAN,
    type: "csv",
    currency: "EUR",
    isActive: true,
    userId: PLACEHOLDER_USER_ID,
    createdAt: now,
    updatedAt: now,
  };
}

// Realistic vendors with typical amounts (in cents)
const EXPENSE_VENDORS = [
  { name: "REWE", partner: "REWE Markt GmbH", amountRange: [500, 8000] as const },
  { name: "EDEKA", partner: "EDEKA Zentrale", amountRange: [300, 6000] as const },
  { name: "Amazon", partner: "AMAZON EU S.A R.L.", amountRange: [999, 25000] as const },
  { name: "Netflix", partner: "NETFLIX.COM", amountRange: [1299, 1799] as const },
  { name: "Spotify", partner: "SPOTIFY AB", amountRange: [999, 1699] as const },
  { name: "Deutsche Bahn", partner: "DB Vertrieb GmbH", amountRange: [1500, 15000] as const },
  { name: "Shell Tankstelle", partner: "SHELL DEUTSCHLAND", amountRange: [3000, 9000] as const },
  { name: "Rossmann", partner: "ROSSMANN GMBH", amountRange: [500, 4000] as const },
  { name: "DM Drogerie", partner: "DM-DROGERIE MARKT", amountRange: [400, 3500] as const },
  { name: "Lidl", partner: "LIDL DIENSTLEISTUNG", amountRange: [800, 7000] as const },
  { name: "McDonalds", partner: "MCDONALD'S", amountRange: [500, 2500] as const },
  { name: "Starbucks", partner: "STARBUCKS COFFEE", amountRange: [350, 1200] as const },
  { name: "IKEA", partner: "IKEA DEUTSCHLAND", amountRange: [2000, 50000] as const },
  { name: "Media Markt", partner: "MEDIA-SATURN", amountRange: [1999, 80000] as const },
  { name: "Telekom", partner: "TELEKOM DEUTSCHLAND", amountRange: [2999, 7999] as const },
  { name: "Vodafone", partner: "VODAFONE GMBH", amountRange: [1999, 4999] as const },
  { name: "HUK Coburg", partner: "HUK-COBURG", amountRange: [5000, 25000] as const },
  { name: "Stadtwerke", partner: "STADTWERKE MÜNCHEN", amountRange: [8000, 25000] as const },
  { name: "Miete", partner: "Hausverwaltung Schmidt", amountRange: [70000, 150000] as const },
];

const INCOME_SOURCES = [
  { name: "Gehalt", partner: "Tech GmbH", amountRange: [300000, 600000] as const },
  { name: "Freelance Zahlung", partner: "Client Corp.", amountRange: [50000, 300000] as const },
  { name: "Erstattung", partner: "Finanzamt", amountRange: [5000, 50000] as const },
  { name: "Gutschrift", partner: null, amountRange: [1000, 10000] as const },
];

// Edge case data. `foreignSupplyKind` / `isReverseCharge` exercise the #214
// foreign-regime fields, `saleSupplyKind` with a 0% `vatRate` the #565 sale
// side; `receiptOnlyAcceptance` (#165) and
// `partialPaymentAcceptance` (#554) are left unset because each presupposes a
// connected File (a receipt, a tipped Beleg), which test data does not create.
const EDGE_CASES: Array<{
  name: string;
  partner: string | null;
  amount: number;
  isReverseCharge?: boolean;
  foreignSupplyKind?: "goods" | "service";
  saleSupplyKind?: SaleSupplyKind;
  vatRate?: number;
  isEuTransaction?: boolean;
}> = [
  { name: "Überweisung Müller & Söhne GmbH", partner: "Müller & Söhne GmbH", amount: 1523400 }, // Large + umlauts
  { name: "Kleinstbetrag Test", partner: "Test Partner", amount: 1 }, // 1 cent
  { name: "Zahlung für Büromöbel inkl. Lieferung, Montage und Entsorgung der alten Möbel sowie Beratungsgebühr", partner: "Möbelhaus Österreich", amount: 234567 }, // Long text
  { name: "Transfer", partner: null, amount: -50000 }, // No partner
  { name: "Unbekannte Abbuchung", partner: null, amount: -9999 }, // No partner expense
  { name: "SEPA-Lastschrift Äöü Spëcial Çhars", partner: "Çömpany ÄÖÜ", amount: -4567 }, // Special chars
  { name: "Großer Einkauf", partner: "Großhandel Berlin", amount: -1500000 }, // 15k expense
  { name: "Investment Auszahlung", partner: "Bank AG", amount: 2500000 }, // 25k income
  { name: "Cent-Rundung", partner: "Paypal", amount: 3 }, // 3 cents
  { name: "Doppelte Buchung Test 1", partner: "Duplicate Corp", amount: -12345 },
  { name: "Doppelte Buchung Test 2", partner: "Duplicate Corp", amount: -12345 }, // Same day duplicate
  { name: "Referenz fehlt", partner: "Anonymous Ltd.", amount: -7890 }, // No reference
  // #214: a foreign B2B service under reverse charge §19 ...
  { name: "AWS Cloud Services", partner: "Amazon Web Services EMEA SARL", amount: -21600, isReverseCharge: true, foreignSupplyKind: "service", isEuTransaction: false },
  // ... and an EU goods purchase (ig. Erwerb) a person classified as goods.
  { name: "Marketplace Warenkauf", partner: "Gadget Versand DE", amount: -7962, foreignSupplyKind: "goods", isEuTransaction: true },
  // #565: a B2B service sold to a UK customer at 0%, not taxable in Austria.
  { name: "Beratung UK Kunde", partner: "Thames Consulting Ltd", amount: 189000, vatRate: 0, saleSupplyKind: "service-non-eu" },
];

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDate(monthsBack: number): Date {
  const now = new Date();
  const start = new Date(now);
  start.setMonth(start.getMonth() - monthsBack);

  const diff = now.getTime() - start.getTime();
  const randomTime = start.getTime() + Math.random() * diff;
  return new Date(randomTime);
}

function formatDateDE(date: Date): string {
  const day = date.getDate().toString().padStart(2, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const year = date.getFullYear();
  return `${day}.${month}.${year}`;
}

function formatAmountDE(cents: number): string {
  const euros = (cents / 100).toFixed(2).replace(".", ",");
  return cents < 0 ? euros : `+${euros}`;
}

async function generateDedupeHash(
  date: Date,
  amount: number,
  reference: string | null
): Promise<string> {
  const dateStr = date.toISOString().split("T")[0];
  const amountStr = amount.toString();
  const ibanNormalized = TEST_SOURCE_IBAN.replace(/\s+/g, "").toUpperCase();
  const refNormalized = (reference || "").trim().toUpperCase();

  const input = `${dateStr}|${amountStr}|${ibanNormalized}|${refNormalized}`;

  const msgBuffer = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generateReference(): string {
  return `REF${Date.now()}${randomInt(1000, 9999)}`;
}

/**
 * Generate 100 test transactions
 */
export async function generateTestTransactions(): Promise<
  Array<Omit<Transaction, "id"> & { id: string }>
> {
  const transactions: Array<Omit<Transaction, "id"> & { id: string }> = [];
  const now = Timestamp.now();

  // Generate 85 realistic transactions
  for (let i = 0; i < 85; i++) {
    const isIncome = Math.random() < 0.15; // 15% income
    const date = randomDate(6);
    const reference = generateReference();

    let name: string;
    let partner: string | null;
    let amount: number;

    if (isIncome) {
      const source = INCOME_SOURCES[randomInt(0, INCOME_SOURCES.length - 1)];
      name = source.name;
      partner = source.partner;
      amount = randomInt(source.amountRange[0], source.amountRange[1]);
    } else {
      const vendor = EXPENSE_VENDORS[randomInt(0, EXPENSE_VENDORS.length - 1)];
      name = vendor.name;
      partner = vendor.partner;
      amount = -randomInt(vendor.amountRange[0], vendor.amountRange[1]); // Negative for expense
    }

    const dedupeHash = await generateDedupeHash(date, amount, reference);
    // Income arrives as a transfer; expenses mix direct debits and card payments.
    const transactionType: TransactionType =
      amount > 0 ? "transfer" : i % 3 === 0 ? "direct_debit" : "card";

    transactions.push({
      id: `test-txn-${i.toString().padStart(3, "0")}`,
      sourceId: TEST_SOURCE_ID,
      date: Timestamp.fromDate(date),
      amount,
      currency: "EUR",
      _original: {
        date: formatDateDE(date),
        amount: formatAmountDE(amount),
        rawRow: {
          Buchungsdatum: formatDateDE(date),
          Betrag: formatAmountDE(amount),
          "Empfänger/Auftraggeber": partner || "",
          Verwendungszweck: name,
          Referenz: reference,
          Buchungsart: BANK_TYPE_WORDING[transactionType],
        },
      },
      name,
      description: null,
      partner,
      reference,
      partnerIban: partner ? `DE${randomInt(10, 99)}${randomInt(10000000, 99999999)}${randomInt(1000000000, 9999999999)}` : null,
      transactionType,
      dedupeHash,
      fileIds: [],
      isComplete: false,
      // Partner fields - explicitly null for Firestore query compatibility
      partnerId: null,
      partnerType: null,
      partnerMatchedBy: null,
      partnerMatchConfidence: null,
      partnerSuggestions: [],
      importJobId: "test-import",
      userId: PLACEHOLDER_USER_ID,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Generate 15 edge case transactions
  const baseDate = new Date();
  for (let i = 0; i < EDGE_CASES.length && i < 15; i++) {
    const edge = EDGE_CASES[i];
    const date = new Date(baseDate);

    // Spread edge cases over last 2 months, some on same day
    if (i < 10) {
      date.setDate(date.getDate() - randomInt(1, 60));
    }
    // Last few on same day for duplicate testing

    const reference = i === 11 ? null : generateReference(); // One without reference
    const dedupeHash = await generateDedupeHash(date, edge.amount, reference);

    transactions.push({
      id: `test-txn-edge-${i.toString().padStart(2, "0")}`,
      sourceId: TEST_SOURCE_ID,
      date: Timestamp.fromDate(date),
      amount: edge.amount,
      currency: "EUR",
      _original: {
        date: formatDateDE(date),
        amount: formatAmountDE(edge.amount),
        rawRow: {
          Buchungsdatum: formatDateDE(date),
          Betrag: formatAmountDE(edge.amount),
          "Empfänger/Auftraggeber": edge.partner || "",
          Verwendungszweck: edge.name,
          Referenz: reference || "",
        },
      },
      name: edge.name,
      description: null,
      partner: edge.partner,
      reference,
      partnerIban: edge.partner ? `DE${randomInt(10, 99)}${randomInt(10000000, 99999999)}${randomInt(1000000000, 9999999999)}` : null,
      // Edge cases carry no bank type: the source printed none (#136).
      transactionType: null,
      dedupeHash,
      fileIds: [],
      isComplete: false,
      // Partner fields - explicitly null for Firestore query compatibility
      partnerId: null,
      partnerType: null,
      partnerMatchedBy: null,
      partnerMatchConfidence: null,
      partnerSuggestions: [],
      importJobId: "test-import-edge",
      userId: PLACEHOLDER_USER_ID,
      // #214 foreign-regime fields, present only on the edge cases that set them
      ...(edge.isReverseCharge !== undefined ? { isReverseCharge: edge.isReverseCharge } : {}),
      ...(edge.foreignSupplyKind !== undefined ? { foreignSupplyKind: edge.foreignSupplyKind } : {}),
      ...(edge.isEuTransaction !== undefined ? { isEuTransaction: edge.isEuTransaction } : {}),
      // #565 sale-side fields
      ...(edge.saleSupplyKind !== undefined ? { saleSupplyKind: edge.saleSupplyKind } : {}),
      ...(edge.vatRate !== undefined ? { vatRate: edge.vatRate } : {}),
      createdAt: now,
      updatedAt: now,
    });
  }

  return transactions;
}
