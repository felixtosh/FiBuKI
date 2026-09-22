/**
 * Decode HTML/XML character references that leaked into extracted text.
 *
 * Used at entity normalisation, where the extracted counterparty entities are
 * shaped (#299): neither a manually uploaded PDF nor a Gmail import runs any
 * HTML escaper on its own, so a name arriving with "&amp;" in it got that way
 * either from the source document's own text or from the extraction model
 * emitting the escaped form. Either way it must be decoded before storage, or
 * every consumer (Partner display, identity matching, export) inherits the
 * corruption — #233 decoded at the two write points instead, which left the
 * STORED entity encoded and the name lane comparing encoded to decoded.
 *
 * The two backfills — `backfillPartnerNameEntities` (#233) and
 * `backfillFileEntityNames` (#299) — use it to repair records written earlier.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

// Named references (amp/lt/gt/quot/apos) and numeric ones (decimal and hex),
// matched literally rather than against the full HTML5 named-entity table —
// those five are what the codebase's own escaper produces (htmlToPdf.ts) and
// what a document or model would plausibly emit.
const ENTITY_PATTERN = /&(#[xX][0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g;

/**
 * Decode named and numeric character references exactly once per match.
 * A single left-to-right pass over the ORIGINAL string, never re-scanning
 * its own output, so double-encoded input ("&amp;amp;") loses one layer
 * ("&amp;") instead of being unwound repeatedly, and a name with no entity
 * in it — including one containing a bare "&" — comes back byte-identical.
 */
export function decodeHtmlEntities(value: string | null | undefined): string | null {
  if (!value) return null;

  return value.replace(ENTITY_PATTERN, (match, body: string) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const codePoint = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        return match;
      }
      return String.fromCodePoint(codePoint);
    }

    return NAMED_ENTITIES[body] ?? match;
  });
}
