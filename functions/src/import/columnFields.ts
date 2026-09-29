/**
 * Shared definitions for CSV column matching: the target fields a bank-export
 * column can map to, the valid format ids, and the response types. Split out of
 * matchColumns.ts so both matching backends (Gemini prompt in matchColumns.ts,
 * Jev typed questions in matchColumnsJev.ts) use one source without a runtime
 * circular import.
 */

export interface ColumnMapping {
  csvColumn: string;
  targetField: string | null;
  confidence: number;
}

export interface MatchColumnsResponse {
  mappings: ColumnMapping[];
  suggestedDateFormat: string | null;
  suggestedAmountFormat: string | null;
  suggestedBalanceFormat: string | null;
}

export interface FieldDefinition {
  key: string;
  label: string;
  description: string;
  aliases: string[];
  required: boolean;
  type: "date" | "amount" | "text" | "iban";
  examples: string[];
}

export const TRANSACTION_FIELDS: FieldDefinition[] = [
  {
    key: "date",
    label: "Transaction Date",
    description:
      "The date when the transaction was booked. Also known as booking date, value date, posting date.",
    aliases: [
      "Buchungsdatum", "Buchungstag", "Valuta", "Valutadatum", "Datum",
      "Date", "Booking Date", "Value Date", "Posted Date", "Transaction Date",
    ],
    required: true,
    type: "date",
    examples: ["15.03.2024", "2024-03-15", "03/15/2024"],
  },
  {
    key: "amount",
    label: "Amount",
    description:
      "The transaction amount. Positive for income, negative for expenses. German format uses comma as decimal (1.234,56).",
    aliases: [
      "Betrag", "Summe", "Umsatz", "Soll", "Haben",
      "Amount", "Value", "Total", "Debit", "Credit",
    ],
    required: true,
    type: "amount",
    examples: ["-1.234,56", "1234.56", "EUR 500,00"],
  },
  {
    key: "name",
    label: "Description / Booking Text",
    description:
      "The main description or booking text. Contains details about the purpose of the payment.",
    aliases: [
      "Buchungstext", "Verwendungszweck", "Text", "Beschreibung",
      "Description", "Memo", "Narrative", "Details", "Reference",
    ],
    required: true,
    type: "text",
    examples: ["AMAZON EU SARL", "Gehalt März 2024", "SEPA Direct Debit"],
  },
  {
    key: "partner",
    label: "Counterparty / Partner",
    description:
      "The name of the other party - sender or receiver of the money.",
    aliases: [
      "Empfänger", "Auftraggeber", "Partner", "Name",
      "Payee", "Payer", "Beneficiary", "Recipient", "Merchant",
    ],
    required: false,
    type: "text",
    examples: ["Max Mustermann", "Amazon EU S.a.r.l.", "Netflix Inc."],
  },
  {
    key: "reference",
    label: "Reference / Transaction ID",
    description:
      "A unique identifier for the transaction. Used for deduplication.",
    aliases: [
      "Referenz", "Transaktions-ID", "Buchungsreferenz", "End-to-End-Referenz",
      "Reference", "Transaction ID", "ID", "Payment Reference",
    ],
    required: false,
    type: "text",
    examples: ["TXN123456789", "E2E-2024031512345"],
  },
  {
    key: "partnerIban",
    label: "Partner IBAN",
    description:
      "The IBAN of the counterparty's bank account. Starts with country code (AT, DE, CH).",
    aliases: [
      "IBAN", "Empfänger-IBAN", "Kontonummer", "Gegenkonto",
      "Partner IBAN", "Account Number", "Beneficiary IBAN",
    ],
    required: false,
    type: "iban",
    examples: ["AT12 3456 7890 1234 5678", "DE89370400440532013000"],
  },
  {
    key: "partnerBic",
    label: "Partner BIC / SWIFT",
    description: "The BIC/SWIFT code of the counterparty's bank.",
    aliases: ["BIC", "SWIFT", "SWIFT-Code", "Bankleitzahl", "BLZ"],
    required: false,
    type: "text",
    examples: ["GIBAATWWXXX", "DEUTDEFF"],
  },
  {
    key: "category",
    label: "Bank Category / Transaction Type",
    description: "The bank's own categorization of the transaction type.",
    aliases: [
      "Kategorie", "Buchungsart", "Transaktionsart", "Typ",
      "Category", "Type", "Transaction Type", "Payment Type",
    ],
    required: false,
    type: "text",
    examples: ["Überweisung", "Lastschrift", "Transfer", "Card Payment"],
  },
  {
    key: "balance",
    label: "Balance After Transaction",
    description: "The account balance after this transaction. Usually not imported.",
    aliases: ["Saldo", "Kontostand", "Balance", "Running Balance"],
    required: false,
    type: "amount",
    examples: ["12.345,67", "1234.56 EUR"],
  },
];

// Valid format IDs. The date ids are the ids of DATE_PARSERS in
// lib/import/date-parsers.ts, hand-duplicated because functions/tsconfig.json
// pins rootDir: "src" and cannot reach the app tree. date-parsers.test.ts
// fails the build if the two drift: an id missing here is a format the AI can
// never suggest, and one that lingers here is a format it can suggest and no
// parser can read (#167, #303). The broker-CSV matcher
// (investments/matchInvestmentColumns.ts) uses this same list rather than a
// copy of its own (#304).
export const DATE_FORMATS = [
  "iso-datetime", "iso-datetime-t", "iso",
  "de", "de-mdy", "de-short", "de-mdy-short",
  "us", "us-short", "eu-slash", "eu-slash-short",
  "dash-dmy", "dash-mdy", "dash-dmy-short", "dash-mdy-short", "text-short", "text-long",
];

export const AMOUNT_FORMATS = [
  "de", "de-space", "us", "us-space",
  "accounting", "accounting-de", "simple", "simple-comma",
];
