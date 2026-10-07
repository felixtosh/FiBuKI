/**
 * What an Extraction hands the File facts module (#637, #639), and how the
 * module turns it into the stored fields.
 *
 * Extraction reads the document: it classifies it, transcribes it, decides the
 * counterparty and the direction, and reconciles the rows with the total into
 * the figures it stores. That reading is the Extraction's own work. Everything
 * derived from it (the Due Date and Debit Date, the Document Type, the review
 * flags) and every stored field name is the module's, so a new derived field
 * or a renamed fact is one change here rather than one per writer.
 *
 * The reading names its facts in the Extraction's own words (`amount`,
 * `partner`); the Due Date and Debit Date are not among them, they are
 * derived. Where each fact is stored is `FACT_FIELD` below and nowhere else.
 */

import { Timestamp } from "firebase-admin/firestore";
import type {
  ExtractedEntity,
  ExtractedInstalment,
  ExtractedLineItem,
  ExtractedRateGroup,
} from "../types/extraction";
import type { ExtractedAdditionalField, ExtractedRawText } from "../extraction/geminiParser";
import type { ParsedQrCode } from "../extraction/qrCodes";
import type { InvoiceDirection } from "../utils/identity-matcher";
import type { RecipientIdentity } from "../matching/recipientIdentity";
import { applyVatDowngradeGuard } from "../extraction/vatSourceGuard";
import { derivePaymentDates } from "./paymentDates";

/**
 * The document's facts as one Extraction read them, after its own
 * reconciliation of the rows with the total. Every key is written, null
 * included, so a fact this reading did not find clears the one an earlier
 * reading left (#376). The three marked optional are the exception the
 * Extraction has always made: absent leaves the stored value as it is.
 */
export interface ExtractedFacts {
  /** The issue date as `YYYY-MM-DD`. Absent leaves the stored date. */
  date?: string;
  /** Absent leaves the stored currency. */
  currency?: string;
  amount: number | null;
  /** The printed Trinkgeld (#172), never part of `amount`. */
  tipAmount: number | null;
  vatAmount: number | null;
  vatPercent: number | null;
  /** The VAT total the document prints (#540). */
  documentVatAmount: number | null;
  qrCodes: ParsedQrCode[] | null;
  country: string | null;
  lineItems: ExtractedLineItem[] | null;
  rateGroups: ExtractedRateGroup[] | null;
  /** Where the Rate Groups came from (#166). */
  rateGroupsSource: "document" | "rksvCode" | null;
  /** The reconciliation's verdict on the rows this reading stores (fork #64). */
  lineItemsUnreconciled: boolean;
  unreconciledRates: number[] | null;
  partner: string | null;
  vatId: string | null;
  iban: string | null;
  address: string | null;
  website: string | null;
  /** The raw text values for search and highlight. Absent leaves the stored ones. */
  raw?: ExtractedRawText;
  /** The rows the Due Date and Debit Date are read from. */
  additionalFields: ExtractedAdditionalField[] | null;
  selfDesignation: string | null;
  invoiceNumber: string | null;
  referencedInvoiceNumber: string | null;
  paidInvoiceNumber: string | null;
  payableAmount: number | null;
  /**
   * The instalments the document prints (#615, ADR-0013), due dates as
   * `YYYY-MM-DD`; stored with each due date as the stored day. null when it
   * prints none.
   */
  instalments: ExtractedInstalment[] | null;
  /** Recorded only, never a Partner (#156). */
  invoicingAgent: ExtractedEntity | null;
}

/** Who the document is between, as the Extraction decided it against the User's identity. */
export interface ExtractedCounterparty {
  invoiceDirection: InvoiceDirection;
  matchedUserAccount: "issuer" | "recipient" | null;
  recipientIdentityMatch: RecipientIdentity;
  issuer: ExtractedEntity | null;
  recipient: ExtractedEntity | null;
}

interface ReadingBase {
  /**
   * The fields of the run itself, stored as given: the transcript, the
   * confidence, the Extraction Service that answered, the page count, the
   * split suggestion, the completion flags. No fact of the document goes
   * here; the module refuses a reading that puts one in.
   */
  run: Record<string, unknown>;
}

/** The document is an invoice, and these are its facts. */
export interface InvoiceReading extends ReadingBase {
  kind: "invoice";
  facts: ExtractedFacts;
  counterparty: ExtractedCounterparty;
  /** Fields whose escape sequence the JSON repair had to guess (#275). */
  repairAmbiguousFields: string[];
}

/**
 * The document is not an invoice (the classifier said so, or its RKSV Code
 * marks a training receipt): every fact is cleared.
 */
export interface NotInvoiceReading extends ReadingBase {
  kind: "not-invoice";
  reason: string;
  /** Present when the Extraction got as far as deciding the counterparty. */
  counterparty?: ExtractedCounterparty;
}

export type ExtractionReading = InvoiceReading | NotInvoiceReading;

/** Where each fact of a reading is stored on the File. */
const FACT_FIELD: Record<
  Exclude<keyof ExtractedFacts, "lineItemsUnreconciled" | "unreconciledRates">,
  string
> = {
  date: "extractedDate",
  currency: "extractedCurrency",
  amount: "extractedAmount",
  tipAmount: "extractedTipAmount",
  vatAmount: "extractedVatAmount",
  vatPercent: "extractedVatPercent",
  documentVatAmount: "extractedDocumentVatAmount",
  qrCodes: "extractedQrCodes",
  country: "extractedCountry",
  lineItems: "extractedLineItems",
  rateGroups: "extractedRateGroups",
  rateGroupsSource: "extractedRateGroupsSource",
  partner: "extractedPartner",
  vatId: "extractedVatId",
  iban: "extractedIban",
  address: "extractedAddress",
  website: "extractedWebsite",
  raw: "extractedRaw",
  additionalFields: "extractedAdditionalFields",
  selfDesignation: "extractedSelfDesignation",
  invoiceNumber: "extractedInvoiceNumber",
  referencedInvoiceNumber: "extractedReferencedInvoiceNumber",
  paidInvoiceNumber: "extractedPaidInvoiceNumber",
  payableAmount: "extractedPayableAmount",
  instalments: "extractedInstalments",
  invoicingAgent: "extractedInvoicingAgent",
};

/** Every stored field an Extraction decides, besides the review flags. */
const STORED_BY_EXTRACTION = new Set<string>([
  ...Object.values(FACT_FIELD),
  "extractedTipBound",
  "extractedDueDate",
  "extractedDebitDate",
  "lineItemsUnreconciled",
  "lineItemsUnreconciledRates",
  "vatSourceDowngraded",
  "vatFieldsPreserved",
  "invoiceDirection",
  "matchedUserAccount",
  "recipientIdentityMatch",
  "extractedIssuer",
  "extractedRecipient",
  "isNotInvoice",
  "notInvoiceReason",
  "extractionCorrectedFields",
  "extractionCorrectedAt",
  "lastFactChange",
]);

/**
 * The stored fields of one Extraction's reading, before the review flags:
 * the facts, the Due Date and Debit Date read off the rows, and the VAT
 * evidence the downgrade guard keeps from the File as it was.
 */
export function extractionFields(
  record: Record<string, unknown>,
  reading: ExtractionReading
): Record<string, unknown> {
  for (const key of Object.keys(reading.run)) {
    if (STORED_BY_EXTRACTION.has(key)) {
      throw new Error(`An Extraction's run fields must not carry "${key}"; it is the module's to write`);
    }
  }

  const update: Record<string, unknown> = { ...reading.run };

  if (reading.counterparty) Object.assign(update, counterpartyFields(reading.counterparty));

  if (reading.kind === "not-invoice") {
    update.isNotInvoice = true;
    update.notInvoiceReason = reading.reason;
    Object.assign(update, notInvoiceClearedFacts());
    return update;
  }

  const { facts } = reading;
  update.isNotInvoice = false;
  update.notInvoiceReason = null;

  for (const [key, field] of Object.entries(FACT_FIELD) as Array<[keyof typeof FACT_FIELD, string]>) {
    const value = facts[key];
    if (key === "date") {
      const date = storedIssueDate(facts.date);
      if (date) update[field] = date;
      continue;
    }
    if (key === "instalments") {
      update[field] = storedInstalments(facts.instalments);
      continue;
    }
    if (value === undefined && (key === "currency" || key === "raw")) continue;
    update[field] = value ?? null;
  }
  // A reading that finds no rows stores none, so a stale row from an earlier
  // reading cannot keep a Due Date alive below.
  if (Array.isArray(facts.additionalFields) && facts.additionalFields.length === 0) {
    update.extractedAdditionalFields = null;
  }
  update.lineItemsUnreconciled = facts.lineItemsUnreconciled;
  update.lineItemsUnreconciledRates =
    facts.unreconciledRates && facts.unreconciledRates.length > 0 ? facts.unreconciledRates : null;

  // #310: the bound belongs to the tip it measured. This tip is the
  // extractor's, so the record of what bounded a hand-set one goes with it.
  update.extractedTipBound = null;

  // #236, #135, #136: the Due Date and Debit Date are read off the rows the
  // File is left with, against the issue date it is left with. A reading with
  // no such row clears the stored date (#639), so a date from an earlier
  // reading does not linger.
  Object.assign(update, derivePaymentDates({ ...record, ...update }));

  // Fork #137: a weaker reading never overwrites a stronger record's VAT.
  applyVatDowngradeGuard(record, update);

  return update;
}

/**
 * The facts a File ruled not an invoice is left without, whichever path ruled
 * it: an Extraction's not-invoice reading, or a person marking it Not Invoice
 * (#710). A document that is not a financial document has no facts, so
 * whatever an earlier reading or a person left goes, the Due Date and Debit
 * Date with the rows they were read from. One list, so both paths classify
 * the same File from the same facts.
 */
export function notInvoiceClearedFacts(): Record<string, unknown> {
  const cleared: Record<string, unknown> = {};
  for (const field of Object.values(FACT_FIELD)) cleared[field] = null;
  cleared.extractedTipBound = null;
  cleared.extractedDueDate = null;
  cleared.extractedDebitDate = null;
  cleared.lineItemsUnreconciled = false;
  cleared.lineItemsUnreconciledRates = null;
  cleared.vatSourceDowngraded = false;
  cleared.vatFieldsPreserved = false;
  return cleared;
}

function counterpartyFields(counterparty: ExtractedCounterparty): Record<string, unknown> {
  return {
    invoiceDirection: counterparty.invoiceDirection,
    matchedUserAccount: counterparty.matchedUserAccount,
    recipientIdentityMatch: counterparty.recipientIdentityMatch,
    extractedIssuer: counterparty.issuer ?? null,
    extractedRecipient: counterparty.recipient ?? null,
  };
}

/** `YYYY-MM-DD` to the stored day: UTC midnight of that calendar day. */
function storedIssueDate(value: string | undefined): Timestamp | null {
  if (!value) return null;
  const parts = value.split("-");
  if (parts.length !== 3) return null;
  const date = new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])));
  return Timestamp.fromDate(date);
}

/** The instalments as stored (#615): each due date the stored day, a missing list null. */
function storedInstalments(
  instalments: ExtractedInstalment[] | null | undefined
): Array<{ amount: number; dueDate: Timestamp | null; label: string | null }> | null {
  if (!Array.isArray(instalments) || instalments.length === 0) return null;
  return instalments.map((row) => ({
    amount: row.amount,
    dueDate: row.dueDate ? storedIssueDate(row.dueDate) : null,
    label: row.label ?? null,
  }));
}
