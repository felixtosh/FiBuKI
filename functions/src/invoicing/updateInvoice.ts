/**
 * Update an invoice.
 * Server recomputes totals + dueDate when relevant fields change.
 * Re-snapshots issuer/recipient if their refs change.
 *
 * Allowed in any status except "cancelled" — the frontend auto-regenerates
 * the PDF after edits to issued/sent/paid invoices.
 */

import { Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import {
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

export interface UpdateInvoiceLineItemInput {
  id?: string;
  description?: string;
  quantity?: number;
  unitPrice?: number;
  vatRate?: number;
}

export interface UpdateInvoicePatch {
  partnerId?: string;
  partnerType?: "user" | "global";
  issuerEntityId?: string;
  issuerIban?: string;
  /** ISO date string */
  issueDate?: string;
  paymentTerms?: string;
  /**
   * Explicit due date override (ISO string). When provided, replaces the
   * auto-computed `issueDate + paymentTerms` value. Lets callers set a
   * specific due date without lying about the payment-terms text.
   */
  dueDate?: string;
  currency?: string;
  lineItems?: UpdateInvoiceLineItemInput[];
  notes?: string | null;
  /** Optional name prefix (e.g. "INV"). Set to "" / null to clear. */
  namePrefix?: string | null;
  /** Positive integer (<= 9999) representing the invoice sequence. */
  numberSeq?: number;
}

export interface UpdateInvoiceRequest {
  invoiceId: string;
  patch: UpdateInvoicePatch;
}

export interface UpdateInvoiceResponse {
  success: boolean;
  invoiceId: string;
  status: string;
}

function genLineItemId(): string {
  return `li_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeLineItems(
  items: UpdateInvoiceLineItemInput[],
): InvoiceLineItem[] {
  return items.map((raw) => ({
    id: raw.id || genLineItemId(),
    description: String(raw.description || "").trim(),
    quantity: Number(raw.quantity) || 0,
    unitPrice: Math.round(Number(raw.unitPrice) || 0),
    vatRate: raw.vatRate !== undefined ? Number(raw.vatRate) : DEFAULT_VAT_RATE,
  }));
}

function parseIsoDateToTimestamp(iso: string): Timestamp | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Timestamp.fromDate(d);
}

function addDaysToTimestamp(ts: Timestamp, days: number): Timestamp {
  const d = ts.toDate();
  d.setDate(d.getDate() + days);
  return Timestamp.fromDate(d);
}

/**
 * Internal implementation for updating an invoice.
 * Can be called directly from MCP handlers.
 */
export async function performUpdateInvoice(
  db: FirebaseFirestore.Firestore,
  userId: string,
  request: UpdateInvoiceRequest,
): Promise<UpdateInvoiceResponse> {
  if (!request?.invoiceId) {
    throw new HttpsError("invalid-argument", "invoiceId is required");
  }
  if (!request?.patch || typeof request.patch !== "object") {
    throw new HttpsError("invalid-argument", "patch is required");
  }

  const docRef = db.collection("invoices").doc(request.invoiceId);
  const snap = await docRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Invoice not found");
  }
  const current = snap.data() as Invoice;
  if (current.userId !== userId) {
    throw new HttpsError("permission-denied", "Not your invoice");
  }
  // Cancelled invoices are frozen; everything else (draft, issued, sent, paid)
  // remains editable. The user can fix typos/numbers post-issue; the caller is
  // expected to re-render the PDF after edits to non-draft invoices.
  if (current.status === "cancelled") {
    throw new HttpsError(
      "failed-precondition",
      "Cancelled invoices cannot be edited",
    );
  }

  const updates: Record<string, unknown> = {};
  const patch = request.patch;

  // Recipient
  if (patch.partnerId !== undefined || patch.partnerType !== undefined) {
    const partnerId = patch.partnerId ?? current.recipient.partnerId;
    const partnerType = patch.partnerType ?? current.recipient.partnerType;
    const recipient = await buildRecipientSnapshot(
      db,
      partnerId,
      partnerType,
      userId,
    );
    if (!recipient) {
      throw new HttpsError("not-found", "Partner not found or not accessible");
    }
    updates.recipient = recipient;
  }

  // Issuer
  if (patch.issuerEntityId !== undefined || patch.issuerIban !== undefined) {
    const userData = await loadUserIdentity(db, userId);
    const entity = pickIssuerEntity(
      userData,
      patch.issuerEntityId ?? current.issuer.entityId,
    );
    if (!entity) {
      throw new HttpsError("failed-precondition", "Issuer entity not found");
    }
    const iban = pickIssuerIban(entity, patch.issuerIban ?? current.issuer.iban);
    if (!iban) {
      throw new HttpsError("failed-precondition", "Selected entity has no IBAN");
    }
    if (patch.issuerIban && !entity.ibans?.includes(patch.issuerIban)) {
      throw new HttpsError("invalid-argument", "issuerIban does not belong to entity");
    }
    updates.issuer = buildIssuerSnapshot(entity, iban);
  }

  // namePrefix / numberSeq
  if (patch.namePrefix !== undefined) {
    if (patch.namePrefix === null || patch.namePrefix === "") {
      updates.namePrefix = null;
    } else {
      const trimmed = String(patch.namePrefix).trim();
      if (trimmed.length > 16) {
        throw new HttpsError(
          "invalid-argument",
          "namePrefix is too long (max 16 characters)",
        );
      }
      updates.namePrefix = trimmed;
    }
  }
  if (patch.numberSeq !== undefined) {
    const n = Number(patch.numberSeq);
    if (!Number.isInteger(n) || n < 1 || n > 9999) {
      throw new HttpsError(
        "invalid-argument",
        "numberSeq must be a positive integer up to 9999",
      );
    }
    updates.numberSeq = n;
  }

  // Simple scalar fields
  if (patch.currency !== undefined) updates.currency = patch.currency;
  if (patch.notes !== undefined) {
    if (patch.notes === null || patch.notes === "") {
      // Use FieldValue.delete-style removal — easier: omit when set blank
      // We'll keep undefined removed by writing null only on explicit clear.
      updates.notes = null;
    } else {
      updates.notes = patch.notes;
    }
  }

  // Date / terms (affect dueDate)
  const nextIssueDate = patch.issueDate
    ? parseIsoDateToTimestamp(patch.issueDate)
    : null;
  if (patch.issueDate && !nextIssueDate) {
    throw new HttpsError("invalid-argument", "issueDate is not a valid date");
  }
  if (nextIssueDate) updates.issueDate = nextIssueDate;

  if (patch.paymentTerms !== undefined) updates.paymentTerms = patch.paymentTerms;

  // Explicit dueDate wins over the issueDate+paymentTerms recomputation.
  // This lets callers set an arbitrary due date without having to fudge
  // the payment-terms text just to make the arithmetic come out right.
  const explicitDueDate = patch.dueDate
    ? parseIsoDateToTimestamp(patch.dueDate)
    : null;
  if (patch.dueDate && !explicitDueDate) {
    throw new HttpsError("invalid-argument", "dueDate is not a valid date");
  }
  if (explicitDueDate) {
    updates.dueDate = explicitDueDate;
  } else if (nextIssueDate || patch.paymentTerms !== undefined) {
    const baseDate = nextIssueDate || current.issueDate;
    const terms = patch.paymentTerms ?? current.paymentTerms;
    updates.dueDate = addDaysToTimestamp(baseDate, parsePaymentTermsToDays(terms));
  }

  // Line items + totals
  if (patch.lineItems !== undefined) {
    const items = normalizeLineItems(patch.lineItems);
    const { subtotal, vatAmount, total } = computeInvoiceTotals(items);
    updates.lineItems = items;
    updates.subtotal = subtotal;
    updates.vatAmount = vatAmount;
    updates.total = total;
  }

  updates.updatedAt = Timestamp.now();

  await docRef.update(updates);

  return { success: true, invoiceId: request.invoiceId, status: current.status };
}

export const updateInvoiceCallable = createCallable<
  UpdateInvoiceRequest,
  UpdateInvoiceResponse
>(
  { name: "updateInvoice" },
  async (ctx, request) => performUpdateInvoice(ctx.db, ctx.userId, request),
);
