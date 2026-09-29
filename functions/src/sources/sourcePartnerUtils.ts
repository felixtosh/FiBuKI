/**
 * Source Partner Utilities
 *
 * Builds partner name and aliases from source data (bank accounts and credit cards).
 * Used when auto-creating source partners for pattern learning + reconciliation.
 */

interface SourceData {
  name: string;
  accountKind: string;
  iban?: string | null;
  cardLast4?: string | null;
  cardBrand?: string | null;
}

interface SourcePartnerData {
  name: string;
  aliases: string[];
  ibans: string[];
}

/**
 * Card brand display names and common variations used in bank transaction text.
 */
const CARD_BRAND_ALIASES: Record<string, string[]> = {
  visa: ["VISA", "Visa"],
  mastercard: ["Mastercard", "MC", "MasterCard"],
  amex: ["AMEX", "American Express", "AmEx"],
  discover: ["Discover"],
};

/**
 * Common German/English payment text patterns that appear alongside card brands.
 * These are combined with the card brand to create aliases.
 */
const PAYMENT_PREFIXES = [
  "Kartenzahlung",
  "Karte",
];

const PAYMENT_SUFFIXES = [
  "Abrechnung",
];

/**
 * Build partner name and aliases from source data.
 *
 * For credit cards: generates brand + last4 combinations and payment text patterns.
 * For bank accounts: uses source name and IBAN.
 */
export function buildSourcePartnerData(source: SourceData): SourcePartnerData {
  const name = source.name.trim();

  if (source.accountKind === "credit_card") {
    return buildCreditCardPartnerData(name, source.cardBrand, source.cardLast4);
  }

  return buildBankAccountPartnerData(name, source.iban);
}

function buildCreditCardPartnerData(
  sourceName: string,
  cardBrand?: string | null,
  cardLast4?: string | null
): SourcePartnerData {
  const aliases: string[] = [];
  const brandNames = cardBrand ? CARD_BRAND_ALIASES[cardBrand] || [cardBrand.toUpperCase()] : [];

  // Brand name variations
  for (const brand of brandNames) {
    aliases.push(brand);

    if (cardLast4) {
      // "VISA 4242", "VISA*4242", "VISA/4242"
      aliases.push(`${brand} ${cardLast4}`);
      aliases.push(`${brand}*${cardLast4}`);
    }

    // Payment text patterns: "Kartenzahlung VISA", "VISA Abrechnung"
    for (const prefix of PAYMENT_PREFIXES) {
      aliases.push(`${prefix} ${brand}`);
    }
    for (const suffix of PAYMENT_SUFFIXES) {
      aliases.push(`${brand} ${suffix}`);
    }
  }

  // Last4-only patterns (brand-independent)
  if (cardLast4) {
    aliases.push(`Karte ${cardLast4}`);
  }

  return {
    name: sourceName,
    aliases,
    ibans: [],
  };
}

function buildBankAccountPartnerData(
  sourceName: string,
  iban?: string | null
): SourcePartnerData {
  return {
    name: sourceName,
    aliases: [],
    ibans: iban ? [iban] : [],
  };
}

interface ExistingPartnerIdentity {
  name?: string | null;
  aliases?: string[] | null;
  ibans?: string[] | null;
}

/**
 * Merge freshly built source Partner data into what the Partner already
 * carries — union, never overwrite (#445).
 *
 * A source Partner can hold more than its source currently says: aliases and
 * IBANs folded in by a merge before #380/#410 refused them, and the previous
 * card's identifiers after a card replacement. Overwriting loses them and
 * their historical Transactions stop matching. So:
 *
 * - Name: keep the existing name unless `renamed` says the update explicitly
 *   set one. Whichever name is displaced (or merely differs) stays findable
 *   as an alias.
 * - Aliases: union of existing and incoming; the Partner's name is never its
 *   own alias.
 * - IBANs: union of existing and incoming, so a replaced card's old IBAN
 *   stays a live alias.
 */
export function mergeSourcePartnerData(
  existing: ExistingPartnerIdentity,
  incoming: SourcePartnerData,
  renamed: boolean
): SourcePartnerData {
  const existingName = (existing.name || "").trim();
  const incomingName = incoming.name.trim();
  const name = renamed && incomingName ? incomingName : existingName || incomingName;

  const aliases = new Set<string>();
  for (const alias of [...(existing.aliases || []), ...incoming.aliases]) {
    const trimmed = (alias || "").trim();
    if (trimmed) aliases.add(trimmed);
  }
  if (existingName) aliases.add(existingName);
  if (incomingName) aliases.add(incomingName);
  aliases.delete(name);

  const ibans = new Set<string>();
  for (const iban of [...(existing.ibans || []), ...incoming.ibans]) {
    if (iban) ibans.add(iban);
  }

  return { name, aliases: [...aliases], ibans: [...ibans] };
}
