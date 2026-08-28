/**
 * Identity matching: does an extracted document entity refer to the user?
 *
 * This is the single source of truth for the question "is this issuer/recipient
 * me?", which decides `invoiceDirection` and which party becomes the
 * counterparty. It used to live in two drifting copies, one in
 * `extraction/extractionCore.ts` and one in `matching/onUserDataUpdate.ts`.
 *
 * The lanes, strongest first: VAT ID, IBAN (identity IBANs, then connected bank
 * accounts), then name. The name lane used to be a two-way substring on the
 * lowercased strings, which missed the three most ordinary ways a real invoice
 * prints a real name (issue #232):
 *
 *   identity            document                 substring   here
 *   Stefan Herbert      STEFAN YAZZIE HERBERT    no          yes  (middle name)
 *   Yazzbert e.U.       Yazzbert eU              no          yes  (punctuation)
 *   Stefan Herbert      HERBERT Stefan           no          yes  (word order)
 *
 * The fix is to normalise (casefold, expand umlauts, strip diacritics, reduce
 * every other character to a separator) and then compare token *sets* rather
 * than substrings: a match when the identity's tokens are all present in the
 * document entity's tokens, in any order. The substring comparison is kept as a
 * fallback so nothing that matched before stops matching.
 */

import { ExtractedEntity } from "../types/extraction";
import {
  hasIdentitySignals,
  hasIssuerEntity,
  hasRecipientEntity,
  resolveRecipientIdentity,
  type RecipientIdentity,
} from "../matching/recipientIdentity";

/** One identity entity: the user as a person, or one of their companies. */
export interface IdentityEntity {
  name: string;
  aliases?: string[];
  vatId?: string;
  ibans?: string[];
}

/**
 * The user's identity data, as stored at `users/{uid}/settings/userData`.
 * Supports the current format (personalEntity + companies[]) and the
 * deprecated flat fields, which older accounts still carry.
 */
export interface UserIdentityData {
  // Current format
  personalEntity?: IdentityEntity;
  companies?: IdentityEntity[];

  // Deprecated flat fields
  name?: string;
  companyName?: string;
  aliases?: string[];
  vatIds?: string[];
  ibans?: string[];
}

export type InvoiceDirection = "incoming" | "outgoing" | "unknown";

export interface CounterpartyResult {
  /** The counterparty entity (the one that is NOT the user) */
  counterparty: ExtractedEntity | null;
  /** Which entity matched the user's identity */
  matchedUserAccount: "issuer" | "recipient" | null;
  /** Invoice direction derived from the match */
  invoiceDirection: InvoiceDirection;
  /**
   * Whether the recipient the document names is the user (#229). Stored so the
   * § 11 classifier can read it: § 11 asks only that a recipient exist, § 12
   * asks whose supply it was, and only the second decides the Vorsteuer.
   */
  recipientIdentityMatch: RecipientIdentity;
}

/** Which signal produced a match. Callers use this for logging. */
export type IdentityMatchLane = "vatId" | "iban" | "sourceIban" | "name";

export interface IdentityMatch {
  lane: IdentityMatchLane;
  /** The value as the document printed it */
  entityValue: string;
  /** The identity value it matched against */
  identityValue: string;
}

// === Name normalisation ===

/**
 * Letters that must be expanded rather than stripped, because decomposition
 * either leaves them untouched (ø, æ, ł carry no combining mark) or produces
 * the wrong word: "ü" decomposes to "u", but "Mueller" is the same name as
 * "Müller" while "Muller" is a different one.
 */
const LETTER_FOLDS: Array<[RegExp, string]> = [
  [/ä/g, "ae"],
  [/ö/g, "oe"],
  [/ü/g, "ue"],
  [/ß/g, "ss"],
  [/æ/g, "ae"],
  [/œ/g, "oe"],
  [/ø/g, "oe"],
  [/ł/g, "l"],
  [/đ/g, "d"],
  [/ð/g, "d"],
  [/þ/g, "th"],
];

/** Combining marks left behind by decomposition: e-acute -> e, c-cedilla -> c. */
const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Casefold, fold diacritics, and reduce every other character to a separator.
 * Both sides of every comparison go through this.
 *
 * Reducing all non-alphanumerics to separators is what handles typographic
 * punctuation, which is the least fixable variant by hand: three live documents
 * printed "Stefan‘s Individual Org" with U+2018 LEFT SINGLE QUOTATION MARK,
 * while the alias was typed with an ASCII apostrophe. The user cannot see which
 * of the two codepoints a document holds, so "add an alias" means guessing at
 * an invisible character.
 */
export function normalizeIdentityName(name: string): string {
  if (!name) return "";

  // Compose first: OCR and PDF text often arrive decomposed, and a decomposed
  // "ü" (u + U+0308) would slip past the fold below and end up as "u" rather
  // than "ue", so the same name would normalise two different ways.
  let normalized = name.normalize("NFC").toLowerCase();

  for (const [pattern, replacement] of LETTER_FOLDS) {
    normalized = normalized.replace(pattern, replacement);
  }

  // NFKD also folds ligatures and fullwidth forms back to plain ASCII letters.
  normalized = normalized.normalize("NFKD").replace(COMBINING_MARKS, "");

  normalized = normalized.replace(/[^a-z0-9]+/g, " ");

  return normalized.trim();
}

/**
 * Legal-form tokens, dropped before comparison. Doing this at token level
 * rather than by stripping a suffix off the end is what makes "e.U." and "eU"
 * agree: punctuation splits the first into two one-character tokens that are
 * dropped as noise, and the second is one token that is dropped here.
 *
 * Deliberately not shared with `partner-matcher.ts`'s COMPANY_SUFFIXES: that
 * list is anchored regexes tuned for fuzzy partner scoring, and matches without
 * word boundaries (it turns "Prag" into "Pr"). Identity matching wants whole
 * tokens.
 */
const LEGAL_FORM_TOKENS = new Set([
  "gmbh",
  "gesmbh",
  "mbh",
  "ag",
  "kg",
  "ohg",
  "og",
  "ug",
  "eu",
  "ek",
  "gbr",
  "eg",
  "ltd",
  "limited",
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "llc",
  "llp",
  "plc",
  "co",
  "sa",
  "sarl",
  "sas",
  "srl",
  "spa",
  "sl",
  "bv",
  "nv",
  "ab",
  "as",
  "oy",
  "aps",
]);

/**
 * The comparable tokens of a name: normalised, deduplicated, with legal-form
 * markers and one-character fragments removed. One-character tokens are noise
 * left behind by punctuation ("Stefan's" -> "stefan", "s") and by initials,
 * which documents print inconsistently.
 */
export function identityNameTokens(name: string): string[] {
  const normalized = normalizeIdentityName(name);
  if (!normalized) return [];

  const tokens = normalized
    .split(" ")
    .filter((token) => token.length > 1 && !LEGAL_FORM_TOKENS.has(token));

  return [...new Set(tokens)];
}

/**
 * Does `entityName`, as printed on a document, refer to the identity known as
 * `identityName`?
 *
 * Two lanes, either is enough:
 *  1. Token subset - every token of the identity appears in the entity, in any
 *     order. This is what covers middle names, punctuation and word order.
 *  2. Substring, on both the raw and the normalised strings. This is the old
 *     behaviour, kept so that nothing which matched before stops matching (for
 *     example the identity being longer than what the document printed).
 */
export function identityNameMatches(identityName: string, entityName: string): boolean {
  if (!identityName || !entityName) return false;

  const identityRaw = identityName.toLowerCase().trim();
  const entityRaw = entityName.toLowerCase().trim();
  if (!identityRaw || !entityRaw) return false;

  const identityTokens = identityNameTokens(identityName);
  const entityTokens = identityNameTokens(entityName);

  // A name made only of legal-form markers carries no identity, and an empty
  // token set is a subset of everything, which would match every document.
  if (identityTokens.length > 0 && entityTokens.length > 0) {
    const entitySet = new Set(entityTokens);
    if (identityTokens.every((token) => entitySet.has(token))) {
      return true;
    }
  }

  if (identityRaw.includes(entityRaw) || entityRaw.includes(identityRaw)) {
    return true;
  }

  const identityNormalized = normalizeIdentityName(identityName);
  const entityNormalized = normalizeIdentityName(entityName);
  if (!identityNormalized || !entityNormalized) return false;

  return (
    identityNormalized.includes(entityNormalized) ||
    entityNormalized.includes(identityNormalized)
  );
}

// === Identity accessors ===

/** All names the user goes by: personal, companies, aliases, legacy fields. */
export function getAllIdentityNames(userData: UserIdentityData): string[] {
  const names: string[] = [];

  if (userData.personalEntity?.name) {
    names.push(userData.personalEntity.name);
    names.push(...(userData.personalEntity.aliases || []));
  }

  for (const company of userData.companies || []) {
    if (company.name) {
      names.push(company.name);
      names.push(...(company.aliases || []));
    }
  }

  if (userData.name) names.push(userData.name);
  if (userData.companyName) names.push(userData.companyName);
  names.push(...(userData.aliases || []));

  return [...new Set(names)].filter(Boolean);
}

/** All VAT IDs belonging to the user. */
export function getAllIdentityVatIds(userData: UserIdentityData): string[] {
  const vatIds: string[] = [];

  if (userData.personalEntity?.vatId) {
    vatIds.push(userData.personalEntity.vatId);
  }
  for (const company of userData.companies || []) {
    if (company.vatId) {
      vatIds.push(company.vatId);
    }
  }

  vatIds.push(...(userData.vatIds || []));

  return [...new Set(vatIds)].filter(Boolean);
}

/** All IBANs the user entered by hand (connected bank accounts are separate). */
export function getAllIdentityIbans(userData: UserIdentityData): string[] {
  const ibans: string[] = [];

  if (userData.personalEntity?.ibans) {
    ibans.push(...userData.personalEntity.ibans);
  }
  for (const company of userData.companies || []) {
    ibans.push(...(company.ibans || []));
  }

  ibans.push(...(userData.ibans || []));

  return [...new Set(ibans)].filter(Boolean);
}

// === Entity matching ===

function normalizeVatId(vatId: string): string {
  return vatId.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeIban(iban: string): string {
  return iban.toUpperCase().replace(/\s/g, "");
}

/**
 * Match a document entity against the user's identity, returning which lane
 * fired and the two values that matched, or null when nothing matched.
 * Lanes are tried strongest first.
 */
export function matchEntityToIdentity(
  entity: ExtractedEntity | null,
  userData: UserIdentityData,
  sourceIbans: string[]
): IdentityMatch | null {
  if (!entity) return null;

  if (entity.vatId) {
    const entityVat = normalizeVatId(entity.vatId);
    for (const identityVat of getAllIdentityVatIds(userData)) {
      if (normalizeVatId(identityVat) === entityVat) {
        return { lane: "vatId", entityValue: entity.vatId, identityValue: identityVat };
      }
    }
  }

  if (entity.iban) {
    const entityIban = normalizeIban(entity.iban);

    for (const identityIban of getAllIdentityIbans(userData)) {
      if (normalizeIban(identityIban) === entityIban) {
        return { lane: "iban", entityValue: entity.iban, identityValue: identityIban };
      }
    }

    // Connected bank accounts arrive already normalised, but normalise again so
    // this lane cannot depend on how the caller built the list.
    for (const sourceIban of sourceIbans) {
      if (normalizeIban(sourceIban) === entityIban) {
        return { lane: "sourceIban", entityValue: entity.iban, identityValue: sourceIban };
      }
    }
  }

  if (entity.name) {
    for (const identityName of getAllIdentityNames(userData)) {
      if (identityNameMatches(identityName, entity.name)) {
        return { lane: "name", entityValue: entity.name, identityValue: identityName };
      }
    }
  }

  return null;
}

/** Boolean form of {@link matchEntityToIdentity}. */
export function entityMatchesUserData(
  entity: ExtractedEntity | null,
  userData: UserIdentityData,
  sourceIbans: string[]
): boolean {
  return matchEntityToIdentity(entity, userData, sourceIbans) !== null;
}

/**
 * Determine the counterparty from the extracted entities. The counterparty is
 * whichever entity is NOT the user.
 */
export function determineCounterparty(
  issuer: ExtractedEntity | null,
  recipient: ExtractedEntity | null,
  userData: UserIdentityData | null,
  sourceIbans: string[]
): CounterpartyResult {
  // Without identity data there is nothing to match against. Default to the
  // issuer as counterparty, which is the legacy behaviour.
  if (!userData) {
    return {
      counterparty: issuer,
      matchedUserAccount: null,
      invoiceDirection: "unknown",
      recipientIdentityMatch: "unknown",
    };
  }

  const issuerMatchesUser = entityMatchesUserData(issuer, userData, sourceIbans);
  const recipientMatchesUser = entityMatchesUserData(recipient, userData, sourceIbans);

  // #229: the same comparison, recorded as its own verdict. A failed match
  // only means "somebody else" when there was something to match against and
  // a recipient to match - see `resolveRecipientIdentity`.
  const identityIsKnown = hasIdentitySignals({
    names: getAllIdentityNames(userData),
    vatIds: getAllIdentityVatIds(userData),
    ibans: getAllIdentityIbans(userData),
    sourceIbans,
  });

  const recipientIdentityMatch = resolveRecipientIdentity({
    recipientPresent: hasRecipientEntity(recipient),
    recipientMatchesUser,
    hasIdentityData: identityIsKnown,
  });

  // User is the issuer, so this is an outgoing invoice and the recipient is the
  // counterparty.
  if (issuerMatchesUser && !recipientMatchesUser) {
    return {
      counterparty: recipient,
      matchedUserAccount: "issuer",
      invoiceDirection: "outgoing",
      recipientIdentityMatch,
    };
  }

  // User is the recipient, so this is an incoming invoice and the issuer is the
  // counterparty.
  if (recipientMatchesUser && !issuerMatchesUser) {
    return {
      counterparty: issuer,
      matchedUserAccount: "recipient",
      invoiceDirection: "incoming",
      recipientIdentityMatch,
    };
  }

  // Both match: an internal transfer or a self-invoice.
  if (issuerMatchesUser && recipientMatchesUser) {
    return {
      counterparty: recipient,
      matchedUserAccount: "issuer",
      invoiceDirection: "outgoing",
      recipientIdentityMatch,
    };
  }

  // Nobody is named as the recipient, and the issuer demonstrably is not the
  // user. Then the user is the recipient by elimination, and the document is a
  // purchase.
  //
  // This is the ordinary case, not an edge one. § 11 Abs 6 expressly permits a
  // Kleinbetragsrechnung up to EUR 400 to print no recipient at all, along with
  // no UID and no sequential number, so every small supplier invoice arrives
  // with the recipient block empty. Requiring a POSITIVE match on one side left
  // that whole class undirected, and an undirected document used to render as a
  // positive amount, i.e. as green income (see documents/directionReview.ts).
  //
  // Three conditions keep the inference honest, and all three are needed:
  //   - identity signals exist, or "the issuer is not the user" means nothing;
  //   - an issuer was actually read, so something was genuinely compared;
  //   - no recipient was read AT ALL. A recipient naming somebody else is a
  //     forwarded document, which is a different thing and stays unknown.
  //
  // The remaining failure mode is a document the user issued whose issuer block
  // extraction misread. The cross-check in directionReview still catches that
  // the moment a transaction is linked, because a sale attached to an outgoing
  // payment contradicts itself.
  if (
    identityIsKnown &&
    !issuerMatchesUser &&
    hasIssuerEntity(issuer) &&
    !hasRecipientEntity(recipient)
  ) {
    return {
      counterparty: issuer,
      // Nothing MATCHED. The direction is inferred, and claiming a matched
      // account here would tell onUserDataUpdate and the file panel that an
      // identity comparison succeeded when none did.
      matchedUserAccount: null,
      invoiceDirection: "incoming",
      recipientIdentityMatch,
    };
  }

  // Neither matches, and there is a recipient naming somebody else, or there is
  // nothing to compare at all: a forwarded invoice, or an extraction that read
  // no entities. Default to the issuer as counterparty.
  return {
    counterparty: issuer,
    matchedUserAccount: null,
    invoiceDirection: "unknown",
    recipientIdentityMatch,
  };
}
