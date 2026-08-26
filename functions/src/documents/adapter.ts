/**
 * Files collection record → `DocumentFacts` (#104).
 *
 * The classifier takes plain data so it can be tested without fixtures; this
 * is the one place that knows what a file document looks like. Same split as
 * `uva/adapter.ts`, and for the same reason — firebase/firestore (web) and
 * firebase-admin (api) types must never meet on a pure module's surface.
 */

import { classifyDocumentType } from "./classifyDocumentType";
import type { DocumentFacts, DocumentTypeResult, RecipientIdentity } from "./types";

/** A files-collection record, as loosely as this module needs to read one. */
export type FileRecord = Record<string, unknown>;

interface EntityLike {
  name?: unknown;
  vatId?: unknown;
  address?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asEntity(value: unknown): EntityLike {
  return value && typeof value === "object" ? (value as EntityLike) : {};
}

/**
 * Read a field that carries a three-state meaning: `undefined` when the
 * record predates the field entirely, `null` when extraction looked and the
 * document printed none. Collapsing the two would let a legacy record
 * masquerade as a document with no invoice number.
 */
function asOptionalString(record: FileRecord, key: string): string | null | undefined {
  if (!(key in record)) return undefined;
  return asString(record[key]);
}

/**
 * Labels under which extraction already files an invoice number, on records
 * written long before #104 gave it a field of its own.
 *
 * Reading it here is what lets a legacy Austrian invoice classify TODAY
 * rather than only after the re-extraction sweep. It can only ever say
 * "present": a record with no such label is still `undefined`, never "the
 * document printed none", so this can add invoices to the queue's denominator
 * but never work to the queue itself.
 */
function invoiceNumberFromAdditionalFields(record: FileRecord): string | undefined {
  const fields = record.extractedAdditionalFields;
  if (!Array.isArray(fields)) return undefined;

  for (const raw of fields) {
    const field = raw as { label?: unknown; value?: unknown };
    const label = typeof field?.label === "string" ? field.label.toLowerCase() : "";
    const value = asString(field?.value);
    if (!label || !value) continue;

    // "Rechnungsnummer", "Rechnungs-Nr." — but never "Rechnungsdatum".
    const german = /rechnungs\s*-?\s*(nummer|nr)/.test(label) || label.includes("belegnummer");
    // "Invoice Number", "Invoice No.", "Order Number / Invoice" — never "Invoice Date".
    const english = label.includes("invoice") && /number|no\.|nr|#/.test(label);

    if (german || english) return value;
  }

  return undefined;
}

/**
 * Whether the recipient this document names is the user (#229).
 *
 * The verdict is computed where the identity data lives — the counterparty
 * matcher, at extraction time and again whenever the user's own entities
 * change — and read here. Anything this module does not recognise is
 * `unknown`, which is also what every record written before #229 carries, and
 * `unknown` demotes nothing.
 *
 * `recipientConfirmedAsUser` is the human override and outranks the verdict.
 * It exists because the comparison is a name match: a maiden name, a c/o
 * address or an OCR slip can put the user's own invoice on the wrong side of
 * it, and the answer to that must not be to weaken the rule for everyone.
 */
function readRecipientIdentity(record: FileRecord): RecipientIdentity {
  if (record.recipientConfirmedAsUser === true) return "user";

  const stored = record.recipientIdentityMatch;
  return stored === "user" || stored === "third-party" ? stored : "unknown";
}

/**
 * The document date is a Firestore Timestamp on the record and an ISO string
 * nowhere. Classification only asks whether one is present, so anything
 * non-null counts.
 */
function hasIssueDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return asString(value);
  return "present";
}

export function toDocumentFacts(record: FileRecord): DocumentFacts {
  const issuer = asEntity(record.extractedIssuer);
  const recipient = asEntity(record.extractedRecipient);

  return {
    grossTotal: asNumber(record.extractedAmount),
    currency: asString(record.extractedCurrency),
    vatPercent: asNumber(record.extractedVatPercent),
    vatAmount: asNumber(record.extractedVatAmount),
    rateGroups: Array.isArray(record.extractedRateGroups)
      ? (record.extractedRateGroups as Array<{ rate?: number | null }>)
      : null,
    lineItems: Array.isArray(record.extractedLineItems)
      ? (record.extractedLineItems as Array<{ description?: string | null; vatPercent?: number | null }>)
      : null,
    // The issuer entity is the supplier § 11 talks about. The flat legacy
    // fields are the counterparty, which is the supplier on every incoming
    // document and the only reading available on a pre-entity record.
    supplierName: asString(issuer.name) ?? asString(record.extractedPartner),
    supplierAddress: asString(issuer.address) ?? asString(record.extractedAddress),
    supplierVatId: asString(issuer.vatId) ?? asString(record.extractedVatId),
    recipientName: asString(recipient.name),
    recipientAddress: asString(recipient.address),
    recipientVatId: asString(recipient.vatId),
    recipientIdentity: readRecipientIdentity(record),
    issueDate: hasIssueDate(record.extractedDate),
    selfDesignation: asOptionalString(record, "extractedSelfDesignation"),
    invoiceNumber:
      "extractedInvoiceNumber" in record
        ? asString(record.extractedInvoiceNumber)
        : invoiceNumberFromAdditionalFields(record),
    text: asString(record.extractedText),
    isNotInvoice: record.isNotInvoice === true,
    isOutgoing:
      record.matchedUserAccount === "issuer" || record.invoiceDirection === "outgoing",
  };
}

/** Classify a stored file record. */
export function classifyFileRecord(record: FileRecord): DocumentTypeResult {
  return classifyDocumentType(toDocumentFacts(record));
}

/**
 * The fields a classification writes onto a file record.
 *
 * `foreignRecipient` is the basis fact hoisted to the top level (#229), and it
 * is deliberately not derived from the REASON: a third-party invoice that also
 * fails § 11 classifies `receipt` for that other defect, and the § 12
 * consequence — this is not the user's Vorsteuer — is unchanged by which
 * verdict the § 11 test reached. Hoisted rather than read through
 * `documentTypeBasis.reason` because it is queried: the UVA derivation, the
 * matching sweep and the review list all ask this question of the record.
 */
export function documentTypeFields(result: DocumentTypeResult): Record<string, unknown> {
  return {
    documentType: result.type,
    documentTypeBasis: result.basis,
    documentTypeMissingElements: result.missingElements,
    foreignRecipient: result.foreignRecipient,
  };
}

/**
 * Compare two stored-shaped values, key order and `undefined` aside.
 *
 * The basis is written as one object, so a stored copy and a fresh verdict can
 * carry the same facts in a different key order; treating that as a change
 * would make every run write the whole corpus.
 */
function sameStoredValue(stored: unknown, next: unknown): boolean {
  if (stored === next) return true;
  if (stored === null || stored === undefined || next === null || next === undefined) {
    return (stored ?? null) === (next ?? null);
  }
  if (Array.isArray(stored) || Array.isArray(next)) {
    if (!Array.isArray(stored) || !Array.isArray(next) || stored.length !== next.length) return false;
    return stored.every((entry, index) => sameStoredValue(entry, next[index]));
  }
  if (typeof stored === "object" && typeof next === "object") {
    const storedRecord = stored as Record<string, unknown>;
    const nextRecord = next as Record<string, unknown>;
    const keys = new Set([...Object.keys(storedRecord), ...Object.keys(nextRecord)]);
    return [...keys].every((key) => sameStoredValue(storedRecord[key], nextRecord[key]));
  }
  return false;
}

/**
 * Would writing this classification onto this record change anything?
 *
 * The file-side twin of `documentationStateChanged`, and there for the same
 * reason: a write that changes nothing costs a document write and re-fires
 * whatever watches the collection. It compares the whole written field set,
 * not just the type — a verdict that keeps its type while its basis or its
 * missing elements move is still an answer worth storing.
 */
export function documentTypeFieldsChanged(
  record: FileRecord,
  result: DocumentTypeResult
): boolean {
  return Object.entries(documentTypeFields(result)).some(
    ([field, value]) => !sameStoredValue(record[field], value)
  );
}
