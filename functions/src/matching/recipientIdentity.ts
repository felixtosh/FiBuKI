/**
 * Is the *Leistungsempfänger* on this document the user? (#229)
 *
 * § 11 asks only that an invoice over 400 EUR name a recipient. § 12 asks
 * whose Unternehmen the supply was rendered to, and only the second question
 * decides whether any Vorsteuer exists for the person holding the document.
 * Nothing asked the second one: an Amazon invoice addressed to a client
 * classified `section-11-satisfied`, and its VAT was one connection away from
 * the UVA.
 *
 * The comparison itself belongs to the counterparty matcher, which is where
 * the user's identity entities are already loaded. This module owns only the
 * verdict that comes out of it, so the rule is testable without Firestore and
 * so both matchers — the extraction path and the identity-change sweep —
 * cannot disagree about it.
 *
 * The whole design rests on one asymmetry: a wrong "third-party" costs a
 * legitimate deduction, a wrong "unknown" costs nothing but a missed catch.
 * So `unknown` is the answer to every question this cannot answer, and it
 * demotes nothing downstream.
 */

import type { RecipientIdentity } from "../documents/types";

export type { RecipientIdentity };

/** An extracted party, as loosely as this module needs to read one. */
export interface RecipientEntityLike {
  name?: string | null;
  vatId?: string | null;
  iban?: string | null;
}

/**
 * The identity a user has actually configured, flattened.
 *
 * Both matchers normalise their own way — one to flat legacy fields, the
 * other across `personalEntity` and `companies[]` — so this takes the lists
 * rather than either shape.
 */
export interface IdentitySignals {
  names?: Array<string | null | undefined>;
  vatIds?: Array<string | null | undefined>;
  ibans?: Array<string | null | undefined>;
  /** IBANs of the user's connected bank accounts, which identify them too. */
  sourceIbans?: Array<string | null | undefined>;
}

function anyNonEmpty(values: Array<string | null | undefined> | undefined): boolean {
  return (values ?? []).some((value) => typeof value === "string" && value.trim().length > 0);
}

/**
 * Has the user given us anything to compare a recipient against?
 *
 * A settings document that exists but is empty normalises to a UserData whose
 * every field is blank, and every comparison against it fails. Without this
 * check that state would mark the entire corpus third-party — the exact
 * failure mode the rule exists to prevent, inverted.
 */
export function hasIdentitySignals(signals: IdentitySignals): boolean {
  return (
    anyNonEmpty(signals.names) ||
    anyNonEmpty(signals.vatIds) ||
    anyNonEmpty(signals.ibans) ||
    anyNonEmpty(signals.sourceIbans)
  );
}

/**
 * Did extraction read this side of the document at all, or is the block empty?
 *
 * Named for the issuer at the one call site that asks about it, so the question
 * reads honestly there. One implementation, because "is there an entity here"
 * is the same question whichever side is asking.
 */
export function hasIssuerEntity(issuer: RecipientEntityLike | null | undefined): boolean {
  return hasRecipientEntity(issuer);
}

/** Did extraction read a recipient at all, or is the block empty? */
export function hasRecipientEntity(recipient: RecipientEntityLike | null | undefined): boolean {
  if (!recipient) return false;
  return (
    anyNonEmpty([recipient.name]) ||
    anyNonEmpty([recipient.vatId]) ||
    anyNonEmpty([recipient.iban])
  );
}

export interface RecipientIdentityInputs {
  /** Extraction read a recipient block with something in it. */
  recipientPresent: boolean;
  /** The counterparty matcher resolved that recipient to the user. */
  recipientMatchesUser: boolean;
  /** The user has identity data configured, so a failed match means something. */
  hasIdentityData: boolean;
}

/**
 * The stored verdict.
 *
 * `third-party` is claimed only when all three of these hold: a recipient was
 * read, identity data exists to compare it against, and the comparison failed.
 * Anything less is `unknown`.
 *
 * A document the user ISSUED lands here as `third-party` too, and correctly
 * so — its recipient is a client. That it is not a § 12 finding is the
 * classifier's call, which reads the direction; recording it as `unknown`
 * here instead would throw away a true fact to save a downstream check.
 */
export function resolveRecipientIdentity(inputs: RecipientIdentityInputs): RecipientIdentity {
  if (!inputs.hasIdentityData) return "unknown";
  if (!inputs.recipientPresent) return "unknown";
  return inputs.recipientMatchesUser ? "user" : "third-party";
}
