/**
 * IBAN helpers only. The duplicate-detection hash is computed on the server and nowhere else
 * (functions/src/imports/dedupe.ts); there is deliberately no client-side copy of that formula.
 */

/**
 * Normalize IBAN by removing spaces and converting to uppercase
 */
export function normalizeIban(iban: string): string {
  return iban.replace(/\s+/g, "").toUpperCase();
}

/**
 * Validate IBAN format (basic check)
 */
export function isValidIban(iban: string): boolean {
  const normalized = normalizeIban(iban);

  // Basic format check: 2 letters + 2 digits + alphanumeric (15-30 chars total)
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,28}$/.test(normalized)) {
    return false;
  }

  // Check length by country (simplified - main European countries)
  const countryLengths: Record<string, number> = {
    AT: 20, // Austria
    DE: 22, // Germany
    CH: 21, // Switzerland
    FR: 27, // France
    IT: 27, // Italy
    ES: 24, // Spain
    NL: 18, // Netherlands
    BE: 16, // Belgium
    GB: 22, // UK
  };

  const country = normalized.slice(0, 2);
  const expectedLength = countryLengths[country];

  if (expectedLength && normalized.length !== expectedLength) {
    return false;
  }

  return true;
}

/**
 * Format IBAN for display (with spaces every 4 characters)
 * Returns "—" if IBAN is not provided
 */
export function formatIban(iban: string | undefined | null): string {
  if (!iban) return "—";
  const normalized = normalizeIban(iban);
  return normalized.replace(/(.{4})/g, "$1 ").trim();
}
