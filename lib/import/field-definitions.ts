import { FieldDefinition } from "@/types/import";

/**
 * Rich field definitions for AI auto-matching of CSV columns.
 * Each field has detailed descriptions, aliases in multiple languages,
 * and example values to help the AI understand what to match.
 */
export const TRANSACTION_FIELDS: FieldDefinition[] = [
  {
    key: "date",
    label: "Transaction Date",
    description:
      "The date when the transaction was booked or executed. This is the primary date field used for sorting and filtering transactions. Also commonly known as booking date, value date, posting date, or transaction date. Should be a date value, not a timestamp with time component.",
    aliases: [
      // German
      "Buchungsdatum",
      "Buchungstag",
      "Valuta",
      "Valutadatum",
      "Datum",
      "Wertstellung",
      "Wertstellungsdatum",
      // English
      "Date",
      "Booking Date",
      "Value Date",
      "Posted",
      "Posted Date",
      "Transaction Date",
      "Posting Date",
      "Entry Date",
      // French
      "Date de valeur",
      "Date d'opération",
    ],
    required: true,
    type: "date",
    examples: ["15.03.2024", "2024-03-15", "03/15/2024", "15/03/24", "15-Mar-2024"],
  },
  {
    key: "amount",
    label: "Amount",
    description:
      "The transaction amount representing money moved. Can be positive (credit, income, deposit) or negative (debit, expense, withdrawal). May include currency symbol. German format uses comma as decimal separator (1.234,56), US format uses period (1,234.56). Negative amounts may be shown with minus sign, parentheses, or in separate debit/credit columns.",
    aliases: [
      // German
      "Betrag",
      "Summe",
      "Wert",
      "Umsatz",
      "Soll",
      "Haben",
      "Soll/Haben",
      "Buchungsbetrag",
      // English
      "Amount",
      "Value",
      "Sum",
      "Total",
      "Debit",
      "Credit",
      "Debit/Credit",
      "Transaction Amount",
      "Payment Amount",
      // French
      "Montant",
      "Débit",
      "Crédit",
    ],
    required: true,
    type: "amount",
    examples: [
      "-1.234,56",
      "1234.56",
      "EUR 500,00",
      "(500.00)",
      "-€50.00",
      "1,234.56 EUR",
    ],
  },
  {
    key: "name",
    label: "Description / Booking Text",
    description:
      "The main description or booking text of the transaction. This is the primary text field that describes what the transaction is for. Contains details about the purpose of the payment, merchant name, or transaction narrative. This is typically the longest text field and may contain multiple pieces of information.",
    aliases: [
      // German
      "Buchungstext",
      "Verwendungszweck",
      "Text",
      "Beschreibung",
      "Zahlungsgrund",
      "Buchungsinformation",
      "Transaktionstext",
      "Umsatztext",
      // English
      "Description",
      "Memo",
      "Narrative",
      "Details",
      "Reference",
      "Transaction Description",
      "Payment Details",
      "Remarks",
      "Notes",
      "Particulars",
      // French
      "Libellé",
      "Description",
      "Motif",
    ],
    required: false,
    type: "text",
    examples: [
      "AMAZON EU SARL",
      "Gehalt März 2024",
      "SEPA Direct Debit",
      "Online Purchase - Netflix",
      "Transfer to savings",
    ],
  },
  {
    key: "partner",
    label: "Counterparty / Partner",
    description:
      "The name of the other party in the transaction - the person, company, or entity that is the sender (for incoming payments) or receiver (for outgoing payments) of the money. This is distinct from the transaction description and specifically identifies WHO the transaction is with.",
    aliases: [
      // German
      "Empfänger",
      "Auftraggeber",
      "Partner",
      "Zahlungsempfänger",
      "Zahlungspflichtiger",
      "Begünstigter",
      "Kontoinhaber",
      "Name",
      "Empfängername",
      "Auftraggebername",
      // English
      "Payee",
      "Payer",
      "Beneficiary",
      "Remitter",
      "Sender",
      "Receiver",
      "Recipient",
      "Counterparty",
      "Account Holder",
      "Name",
      "Merchant",
      // French
      "Bénéficiaire",
      "Donneur d'ordre",
    ],
    required: false,
    type: "text",
    examples: [
      "Max Mustermann",
      "Amazon EU S.a.r.l.",
      "Finanzamt Wien",
      "John Smith",
      "Netflix Inc.",
    ],
  },
  {
    key: "reference",
    label: "Reference / Transaction ID",
    description:
      "A unique identifier or reference number for the transaction assigned by the bank. Used for deduplication to prevent importing the same transaction twice. May be called transaction ID, reference number, booking reference, or end-to-end reference. Often an alphanumeric code.",
    aliases: [
      // German
      "Referenz",
      "Transaktions-ID",
      "Transaktionsnummer",
      "Buchungsreferenz",
      "Zahlungsreferenz",
      "End-to-End-Referenz",
      "End-to-End-ID",
      "Kundenreferenz",
      "Mandatsreferenz",
      // English
      "Reference",
      "Transaction ID",
      "Transaction Number",
      "ID",
      "Booking Reference",
      "Payment Reference",
      "End-to-End Reference",
      "Customer Reference",
      "Check Number",
      "Cheque Number",
      // French
      "Référence",
      "Numéro de transaction",
    ],
    required: false,
    type: "text",
    examples: [
      "TXN123456789",
      "NOTPROVIDED",
      "RF123456",
      "E2E-2024031512345",
      "CHK00001234",
    ],
  },
  {
    key: "partnerIban",
    label: "Partner IBAN",
    description:
      "The International Bank Account Number (IBAN) of the counterparty's bank account. Used for identifying the other party's account in SEPA transfers. Format varies by country but typically starts with country code (e.g., AT, DE, CH) followed by numbers.",
    aliases: [
      // German
      "IBAN",
      "Empfänger-IBAN",
      "Auftraggeber-IBAN",
      "Partner IBAN",
      "Kontonummer",
      "Konto-Nr",
      "Konto",
      "BLZ/Konto",
      "Gegenkonto",
      // English
      "IBAN",
      "Partner IBAN",
      "Account Number",
      "Account",
      "Beneficiary IBAN",
      "Counterparty Account",
      // French
      "IBAN",
      "Compte",
    ],
    required: false,
    type: "iban",
    examples: [
      "AT12 3456 7890 1234 5678",
      "DE89370400440532013000",
      "CH93 0076 2011 6238 5295 7",
    ],
  },
  {
    key: "partnerBic",
    label: "Partner BIC / SWIFT",
    description:
      "The Bank Identifier Code (BIC) or SWIFT code of the counterparty's bank. An 8 or 11 character code identifying the bank. Used in international transfers.",
    aliases: [
      // German
      "BIC",
      "SWIFT",
      "SWIFT-Code",
      "BIC/SWIFT",
      "Bankleitzahl",
      "BLZ",
      // English
      "BIC",
      "SWIFT",
      "SWIFT Code",
      "Bank Code",
      "Sort Code",
      "Routing Number",
    ],
    required: false,
    type: "text",
    examples: ["GIBAATWWXXX", "DEUTDEFF", "BNPAFRPP"],
  },
  {
    key: "category",
    label: "Bank Category / Transaction Type",
    description:
      "The category or type of transaction as classified by the bank. This is the bank's own categorization, not user-defined categories. Indicates the nature of the transaction like transfer, direct debit, card payment, etc.",
    aliases: [
      // German
      "Kategorie",
      "Buchungsart",
      "Transaktionsart",
      "Umsatzart",
      "Typ",
      "Art",
      "Zahlungsart",
      // English
      "Category",
      "Type",
      "Transaction Type",
      "Payment Type",
      "Transaction Category",
      // French
      "Catégorie",
      "Type",
    ],
    required: false,
    type: "text",
    examples: [
      "Überweisung",
      "Lastschrift",
      "Transfer",
      "Direct Debit",
      "Card Payment",
      "Standing Order",
    ],
  },
  {
    key: "balance",
    label: "Balance After Transaction",
    description:
      "The account balance after this transaction was processed. This is the running balance and is typically NOT imported as a transaction field, but may be useful as metadata. Usually shown in the same format as amounts.",
    aliases: [
      // German
      "Saldo",
      "Kontostand",
      "Neuer Saldo",
      "Aktueller Saldo",
      // English
      "Balance",
      "Running Balance",
      "Account Balance",
      "New Balance",
      // French
      "Solde",
    ],
    required: false,
    type: "amount",
    examples: ["12.345,67", "€5,432.10", "1234.56 EUR"],
  },
];

/**
 * Get field definition by key
 */
export function getFieldDefinition(key: string): FieldDefinition | undefined {
  return TRANSACTION_FIELDS.find((f) => f.key === key);
}

/**
 * Get all required fields
 */
export function getRequiredFields(): FieldDefinition[] {
  return TRANSACTION_FIELDS.filter((f) => f.required);
}

/**
 * Get field by alias (case-insensitive)
 */
export function findFieldByAlias(alias: string): FieldDefinition | undefined {
  const lowerAlias = alias.toLowerCase().trim();
  return TRANSACTION_FIELDS.find((f) =>
    f.aliases.some((a) => a.toLowerCase() === lowerAlias)
  );
}

/**
 * Build the AI prompt context for field matching
 */
export function buildFieldDescriptionsForAI(): string {
  return TRANSACTION_FIELDS.map(
    (f) =>
      `- **${f.key}** (${f.required ? "required" : "optional"}): ${f.description}\n  Examples: ${f.examples.join(", ")}`
  ).join("\n\n");
}
