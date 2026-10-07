/**
 * The one applier of the File facts module (#637, #638).
 *
 * Reads what the module needs (the File, the Transactions it is connected
 * to), asks the module, writes the update it returns and runs the follow-ups.
 * Nothing is written on a refusal. Every path that changes a File's extracted
 * facts goes through here, so the write and its follow-ups happen the same
 * way whichever door the change came in by.
 */

import type { Firestore } from "firebase-admin/firestore";
import { readLinkedTransactions } from "../documents/syncDirectionReview";
import { syncDocumentationStateForTransactions } from "../documents/syncDocumentationState";
import { rescoreFileSuggestions } from "../matching/rescoreFileSuggestions";
import { decideFactChange, type FactChange, type FactUpdate, type FollowUp } from "./factChange";
import { activityEntry, logActivity, type ActivityActor } from "../utils/activity";

export interface ApplyFactChangeRequest {
  fileId: string;
  /** The caller's uid. The File must belong to it. */
  userId: string;
  change: FactChange;
  /**
   * Who asked, for the File's activity log (#752). Defaults from the origin:
   * the panel is the User, the MCP correction and the Extraction are AI, the
   * sweep and the generated invoice are FiBuKI. The not-invoice ruling is the
   * User's unless the caller says the agent made it.
   */
  actor?: ActivityActor;
}

export type AppliedFactChange =
  | (FactUpdate & {
      /** The File as it was read. */
      before: Record<string, unknown>;
      /** The File as the update left it. */
      after: Record<string, unknown>;
    })
  | { refused: true; code: "NOT_FOUND" | "INVALID" | "HAND_CORRECTED"; message: string; fields?: string[] };

export async function applyFactChange(
  db: Firestore,
  { fileId, userId, change, actor }: ApplyFactChangeRequest
): Promise<AppliedFactChange> {
  const ref = db.collection("files").doc(fileId);
  const snap = await ref.get();

  // Someone else's File answers like a missing one: every user shares one
  // tenant, so its existence is not the caller's business.
  if (!snap.exists || snap.data()?.userId !== userId) {
    return { refused: true, code: "NOT_FOUND", message: "File not found" };
  }

  const record = snap.data()!;
  const transactionIds = Array.isArray(record.transactionIds) ? (record.transactionIds as string[]) : [];
  const linkedTransactions = await readLinkedTransactions(db, transactionIds);

  const outcome = decideFactChange({ record, linkedTransactions }, change);
  if (outcome.refused) return outcome;

  if (Object.keys(outcome.update).length > 0) {
    const entry = factChangeActivity(change, outcome.update, actor);
    await ref.update(entry ? { ...outcome.update, ...logActivity(entry) } : outcome.update);
  }

  await runFollowUps(db, fileId, outcome.followUps);

  return { ...outcome, before: record, after: { ...record, ...outcome.update } };
}

/**
 * Carry out the follow-ups. The write they follow has already succeeded, so a
 * failing follow-up is logged, never thrown: the User's correction stands, and
 * a stale derived state is repaired by the next change that touches it.
 */
async function runFollowUps(db: Firestore, fileId: string, followUps: FollowUp[]): Promise<void> {
  for (const followUp of followUps) {
    try {
      if (followUp.kind === "sync-documentation-state") {
        await syncDocumentationStateForTransactions(db, followUp.transactionIds);
      } else if (followUp.kind === "rescore-suggestions") {
        await rescoreFileSuggestions(db, fileId);
      }
    } catch (error) {
      console.error(`[FileFacts] Follow-up ${followUp.kind} failed for file ${fileId}:`, error);
    }
  }
}

/** The facts a person recognises, by stored field, in the order the log names them. */
const FACT_LABELS: ReadonlyArray<[string, string]> = [
  ["extractedAmount", "amount"],
  ["extractedCurrency", "currency"],
  ["extractedDate", "date"],
  ["extractedPartner", "partner name"],
  ["extractedVatPercent", "VAT rate"],
  ["extractedVatAmount", "VAT amount"],
  ["extractedInvoiceNumber", "invoice number"],
  ["extractedIban", "IBAN"],
  ["extractedVatId", "VAT ID"],
  ["extractedDueDate", "due date"],
  ["extractedDebitDate", "debit date"],
  ["extractedLineItems", "line items"],
  ["extractedRateGroups", "VAT groups"],
  ["extractedTipAmount", "tip"],
  ["extractedIssuer", "issuer"],
  ["extractedRecipient", "recipient"],
  ["invoiceDirection", "direction"],
  ["documentType", "document type"],
  ["isNotInvoice", "invoice status"],
];

/** "amount, date and partner name", or null when no recognisable fact is among the keys. */
function factsNamed(keys: string[]): string | null {
  const present = new Set(keys);
  const names = FACT_LABELS.filter(([field]) => present.has(field)).map(([, label]) => label);
  if (names.length === 0) return null;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const ORIGIN_ACTOR: Record<FactChange["origin"], ActivityActor> = {
  "ui-correction": "manual",
  "mcp-correction": "ai",
  extraction: "ai",
  "not-invoice": "manual",
  "identity-sweep": "auto",
  "generated-invoice": "auto",
  "entity-name-backfill": "auto",
};

/**
 * The File's log line for a Fact Change (#752), or null when no fact moved.
 * The one-off name backfill only decodes stored text and is not logged.
 */
export function factChangeActivity(
  change: FactChange,
  update: Record<string, unknown>,
  actor: ActivityActor | undefined
): Record<string, unknown> | null {
  if (change.origin === "entity-name-backfill") return null;
  const named = factsNamed(Object.keys(update));
  // Review flags and stamps alone are no change a person would recognise.
  if (!named && change.origin !== "not-invoice") return null;
  const who = actor ?? ORIGIN_ACTOR[change.origin];
  const listed = named ?? "details";
  switch (change.origin) {
    case "extraction":
      if (change.reading.kind === "not-invoice") {
        return activityEntry({
          type: "marked_not_invoice",
          actor: who,
          summary: `Classified as not an invoice: ${change.reading.reason}`,
        });
      }
      return activityEntry({
        type: "extracted",
        actor: who,
        summary: change.forced ? `Document read again, hand corrections overwritten: ${listed}` : `Document read: ${listed}`,
      });
    case "not-invoice":
      return activityEntry({
        type: "marked_not_invoice",
        actor: who,
        summary: change.reason ? `Marked as not an invoice: ${change.reason}` : "Marked as not an invoice",
      });
    case "identity-sweep":
      return activityEntry({ type: "facts_derived", actor: who, summary: `Re-derived from your company details: ${listed}` });
    case "generated-invoice":
      return activityEntry({ type: "facts_derived", actor: who, summary: `Taken from the invoice FiBuKI generated: ${listed}` });
    default:
      return activityEntry({ type: "facts_corrected", actor: who, summary: `Corrected: ${listed}` });
  }
}
