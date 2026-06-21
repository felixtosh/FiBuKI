/**
 * Create a draft invoice.
 *
 * Returns the new invoiceId. Snapshots issuer + recipient at creation time.
 * Number is a "DRAFT-{shortId}" placeholder; the real number is allocated
 * atomically at issue time.
 */

import { Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import {
  DEFAULT_CURRENCY,
  DEFAULT_PAYMENT_TERMS,
  DEFAULT_VAT_RATE,
  Invoice,
  InvoiceLineItem,
  computeInvoiceTotals,
  parsePaymentTermsToDays,
} from "./types";
import {
  buildIssuerSnapshot,
  buildRecipientSnapshot,
  loadUserIdentity,
  pickIssuerEntity,
  pickIssuerIban,
} from "./snapshots";
import {
  InvoiceIssuerSnapshot,
  InvoiceRecipientSnapshot,
} from "./types";

function buildBlankIssuerSnapshot(): InvoiceIssuerSnapshot {
  return { entityId: "", name: "", iban: "" };
}
async function buildBlankRecipientSnapshot(): Promise<InvoiceRecipientSnapshot> {
  return { partnerId: "", partnerType: "user", name: "" };
}

export interface CreateInvoiceLineItemInput {
  id?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  vatRate?: number;
}

export interface CreateInvoiceRequest {
  /**
   * Optional recipient. When omitted the invoice is created as a blank
   * draft and the user fills in the partner in the sidebar. issueInvoice
   * still validates that a real partner/issuer are set before generating
   * the PDF.
   */
  partnerId?: string;
  partnerType?: "user" | "global";
  issuerEntityId?: string;
  issuerIban?: string;
  /** ISO date string. Defaults to today. */
  issueDate?: string;
  paymentTerms?: string;
  currency?: string;
  lineItems?: CreateInvoiceLineItemInput[];
  notes?: string;
}

export interface CreateInvoiceResponse {
  success: boolean;
  invoiceId: string;
  /** The stub TaxFile id created alongside the draft invoice. */
  fileId: string;
}

function shortRandomId(): string {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

function genLineItemId(): string {
  return `li_${Math.random().toString(36).slice(2, 10)}`;
}

function parseIsoDateToTimestamp(iso?: string): Timestamp {
  if (!iso) return Timestamp.now();
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return Timestamp.now();
  return Timestamp.fromDate(d);
}

function addDaysToTimestamp(ts: Timestamp, days: number): Timestamp {
  const d = ts.toDate();
  d.setDate(d.getDate() + days);
  return Timestamp.fromDate(d);
}

function normalizeLineItems(
  items: CreateInvoiceLineItemInput[] | undefined,
): InvoiceLineItem[] {
  if (!items || items.length === 0) return [];
  return items.map((raw) => ({
    id: raw.id || genLineItemId(),
    description: String(raw.description || "").trim(),
    quantity: Number(raw.quantity) || 0,
    unitPrice: Math.round(Number(raw.unitPrice) || 0),
    vatRate: raw.vatRate !== undefined ? Number(raw.vatRate) : DEFAULT_VAT_RATE,
  }));
}

/**
 * Internal implementation for creating an invoice.
 * Can be called directly from MCP handlers.
 */
export async function performCreateInvoice(
  db: FirebaseFirestore.Firestore,
  userId: string,
  request: CreateInvoiceRequest,
): Promise<CreateInvoiceResponse> {
  // Recipient: optional at draft time. Fill in via updateInvoice when the
  // user picks/creates a partner in the sidebar. Placeholder snapshot keeps
  // the Invoice schema non-nullable; issueInvoice validates real data is
  // present before generating the PDF.
  let recipient = await buildBlankRecipientSnapshot();
  if (request.partnerId) {
    const partnerType = request.partnerType ?? "user";
    if (partnerType !== "user" && partnerType !== "global") {
      throw new HttpsError("invalid-argument", "partnerType must be 'user' or 'global'");
    }
    const real = await buildRecipientSnapshot(db, request.partnerId, partnerType, userId);
    if (!real) {
      throw new HttpsError("not-found", "Partner not found or not accessible");
    }
    recipient = real;
  }

  // Issuer: optional at draft time. If the user already has an identity
  // entity with an IBAN, snapshot it as a sensible default; otherwise leave
  // it blank and let the sidebar prompt the user to fill it in.
  let issuer = buildBlankIssuerSnapshot();
  const userData = await loadUserIdentity(db, userId);
  const entity = pickIssuerEntity(userData, request.issuerEntityId);
  if (entity) {
    if (request.issuerIban && !entity.ibans?.includes(request.issuerIban)) {
      throw new HttpsError(
        "invalid-argument",
        "issuerIban does not belong to the selected entity",
      );
    }
    const iban = pickIssuerIban(entity, request.issuerIban);
    if (iban) {
      issuer = buildIssuerSnapshot(entity, iban);
    }
  }

  // Dates
  const issueDate = parseIsoDateToTimestamp(request.issueDate);
  const paymentTerms = request.paymentTerms || DEFAULT_PAYMENT_TERMS;
  const dueDate = addDaysToTimestamp(issueDate, parsePaymentTermsToDays(paymentTerms));

  // Line items + totals. Drafts always carry at least one empty row so the
  // editor opens with an actionable line, and issueInvoice's
  // "at least one line item" guard is satisfied the moment the user types
  // a description.
  let lineItems = normalizeLineItems(request.lineItems);
  if (lineItems.length === 0) {
    lineItems = [
      {
        id: genLineItemId(),
        description: "",
        quantity: 1,
        unitPrice: 0,
        vatRate: DEFAULT_VAT_RATE,
      },
    ];
  }
  const { subtotal, vatAmount, total } = computeInvoiceTotals(lineItems);

  // Pre-fill numberSeq with (highest existing seq for this user+year) + 1.
  // We deliberately don't filter by namePrefix to avoid an extra composite
  // index; the seq is shared across all of the user's invoices in this year.
  // Issued invoices remain stable (number is frozen at issue time), so this
  // only affects what the upcoming draft's seq looks like.
  const issueYear = issueDate.toDate().getFullYear();
  let numberSeq = 1;
  try {
    // Scan ALL of the user's invoices (no date filter) and look at both
    // structured numberSeq AND the trailing 4-digit chunk of the legacy
    // `number` field for the current year. Year filter was dropping older
    // sequences when timezone math pushed issueDate across the boundary;
    // doing it manually below keeps things consistent.
    const seqQuery = await db
      .collection("invoices")
      .where("userId", "==", userId)
      .get();
    let maxSeq = 0;
    const yearRegex = new RegExp(`-${issueYear}-(\\d{1,6})$`);
    seqQuery.forEach((doc) => {
      const data = doc.data() as {
        numberSeq?: number;
        number?: string;
        issueDate?: { toDate: () => Date };
      };
      // Same-year guard: prefer the doc's stored issueDate year, fall back
      // to parsing the year from the number string.
      let docYear: number | null = null;
      try {
        docYear = data.issueDate?.toDate?.().getFullYear() ?? null;
      } catch {
        docYear = null;
      }
      if (docYear !== null && docYear !== issueYear) return;

      if (typeof data.numberSeq === "number" && data.numberSeq > maxSeq) {
        maxSeq = data.numberSeq;
      }
      // Legacy fallback: parse "{prefix}-{year}-{NNNN}" from data.number.
      if (typeof data.number === "string") {
        const m = data.number.match(yearRegex);
        if (m) {
          const legacySeq = parseInt(m[1], 10);
          if (!Number.isNaN(legacySeq) && legacySeq > maxSeq) {
            maxSeq = legacySeq;
          }
        }
      }
    });
    numberSeq = maxSeq + 1;
  } catch (err) {
    // Non-fatal — fall back to 1 and let the user adjust manually.
    console.warn("createInvoice: failed to compute next numberSeq", err);
  }

  const now = Timestamp.now();
  const docRef = db.collection("invoices").doc();
  const fileRef = db.collection("files").doc();

  const invoiceData: Omit<Invoice, "id"> = {
    userId,
    number: `DRAFT-${shortRandomId()}`,
    status: "draft",
    numberSeq,
    issuer,
    recipient,
    issueDate,
    paymentTerms,
    dueDate,
    lineItems,
    currency: request.currency || DEFAULT_CURRENCY,
    subtotal,
    vatAmount,
    total,
    fileId: fileRef.id,
    createdAt: now,
    updatedAt: now,
  };

  if (request.notes) {
    (invoiceData as Invoice).notes = request.notes;
  }

  // Stub TaxFile so the draft invoice appears as a row in the files list.
  // The PDF doesn't exist yet (storagePath/downloadUrl empty); issueInvoice
  // updates this same doc in place once the PDF is rendered.
  //
  // extractionComplete=true + isFibukiGenerated=true short-circuits the
  // extractFileData onCreate trigger (see functions/src/extraction/extractFileData.ts).
  const fileData: Record<string, unknown> = {
    userId,
    fileName: "Rechnungsentwurf",
    fileType: "application/pdf",
    fileSize: 0,
    storagePath: "",
    downloadUrl: "",
    extractionComplete: true,
    classificationComplete: true,
    isNotInvoice: false,
    isFibukiGenerated: true,
    sourceType: "fibuki_invoice",
    invoiceId: docRef.id,
    invoiceDirection: "outgoing",
    matchedUserAccount: "issuer",
    transactionIds: [],
    uploadedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  // Set both docs in a single batch so the file row appears alongside the
  // invoice doc atomically.
  const batch = db.batch();
  batch.set(docRef, invoiceData);
  batch.set(fileRef, fileData);
  await batch.commit();

  return { success: true, invoiceId: docRef.id, fileId: fileRef.id };
}

export const createInvoiceCallable = createCallable<
  CreateInvoiceRequest,
  CreateInvoiceResponse
>(
  { name: "createInvoice" },
  async (ctx, request) => performCreateInvoice(ctx.db, ctx.userId, request),
);
