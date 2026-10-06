/**
 * The identity sweep's facts, as the File facts module writes them (#640).
 *
 * When the User edits their identity, the sweep re-derives each File's
 * direction and counterparty from the entities its Extraction read
 * (`onUserDataUpdate`). It hands the module what it derived; the module
 * decides what of it is written.
 *
 * A direction the User set by hand is kept (#637 user story 10). A sweep used
 * to flip it back whenever the derivation disagreed, silently. Kept with it is
 * everything the direction chooses: which side is the User
 * (`matchedUserAccount`) and which side is the counterparty, whose name, VAT
 * ID, IBAN, address and website the File carries. Writing the derived
 * counterparty beside the User's direction would name the User as their own
 * counterparty. Whether the recipient is the User (`recipientIdentityMatch`)
 * is a verdict on the recipient alone, so it still moves.
 */

import type { ExtractedEntity } from "../types/extraction";
import type { InvoiceDirection } from "../utils/identity-matcher";
import type { RecipientIdentity } from "../matching/recipientIdentity";
import { correctedFieldsOf } from "./provenance";

/** What the sweep derived for one File from its entities and the User's identity now. */
export interface SweepDerivation {
  invoiceDirection: InvoiceDirection;
  matchedUserAccount: "issuer" | "recipient" | null;
  recipientIdentityMatch: RecipientIdentity;
  /** The counterparty entity, its name already decoded (#299). */
  counterparty: ExtractedEntity | null;
}

export interface SweepFields {
  /** The facts this sweep moves, before the derived fields. Empty when nothing moved. */
  update: Record<string, unknown>;
  /** The direction a Hand Correction kept, when the derivation disagreed with it. */
  keptDirection: { stored: InvoiceDirection; derived: InvoiceDirection } | null;
}

export function sweepFields(record: Record<string, unknown>, derived: SweepDerivation): SweepFields {
  const storedDirection = (record.invoiceDirection ?? "unknown") as InvoiceDirection;
  const keepDirection =
    correctedFieldsOf(record).includes("invoiceDirection") &&
    derived.invoiceDirection !== storedDirection;

  // An absent name is spelled null on both sides of the comparison (#341):
  // `name` is optional on a stored entity, and `undefined !== null` read a
  // nameless counterparty as a change on every sweep, re-arming partner
  // matching and wiping a Partner the user had assigned by hand.
  const counterpartyName = derived.counterparty?.name ?? null;
  const storedPartner = (record.extractedPartner as string | null | undefined) ?? null;

  const identityMoved = derived.recipientIdentityMatch !== record.recipientIdentityMatch;
  const directionMoved =
    !keepDirection &&
    (derived.invoiceDirection !== record.invoiceDirection ||
      derived.matchedUserAccount !== record.matchedUserAccount ||
      counterpartyName !== storedPartner);

  const keptDirection = keepDirection
    ? { stored: storedDirection, derived: derived.invoiceDirection }
    : null;

  if (!identityMoved && !directionMoved) return { update: {}, keptDirection };

  const update: Record<string, unknown> = { recipientIdentityMatch: derived.recipientIdentityMatch };
  if (keepDirection) return { update, keptDirection };

  update.invoiceDirection = derived.invoiceDirection;
  update.matchedUserAccount = derived.matchedUserAccount;

  // The absent ones are written as null rather than left out, because these
  // fields mirror whoever the counterparty currently is, and this sweep is
  // what re-points them when the identity moves. Leaving one out would keep
  // the PREVIOUS counterparty's VAT ID or IBAN on the File, and partner
  // matching, which is re-armed below, matches on both. Copying them raw put
  // `undefined` in the payload, which Firestore refuses (#158).
  if (derived.counterparty) {
    update.extractedPartner = counterpartyName;
    update.extractedVatId = derived.counterparty.vatId ?? null;
    update.extractedIban = derived.counterparty.iban ?? null;
    update.extractedAddress = derived.counterparty.address ?? null;
    update.extractedWebsite = derived.counterparty.website ?? null;
  }

  // A new counterparty name re-runs partner matching.
  if (counterpartyName !== storedPartner) {
    update.partnerMatchComplete = false;
    update.partnerId = null;
    update.partnerMatchedBy = null;
    update.partnerMatchConfidence = null;
    update.partnerSuggestions = [];
  }

  return { update, keptDirection };
}
