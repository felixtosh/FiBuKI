/**
 * What decoding a stored Partner's name and aliases would change (#266).
 *
 * The one place both Partner backfills decide what to write: the per-user
 * callable (`backfillPartnerNameEntities`, #233) and the self-host pass over
 * every tenant (`selfhost/migrate-decode-partner-name-entities.ts`). Both go
 * through `decodeHtmlEntities`, the decoder extraction uses, so the stored
 * corpus ends up spelled the way new extractions spell it.
 *
 * Idempotency needs the marker. The decoder removes exactly one layer, so a
 * double-encoded name ("AL&amp;amp;FA") becomes "AL&amp;FA" and a second pass
 * would strip the next layer. A Partner the backfill has already rewritten
 * carries `nameEntitiesDecodedAt` and is never decoded again.
 */

import { decodeHtmlEntities } from "../utils/htmlEntities";

/** Stamped on a Partner the backfill rewrote, so a re-run leaves it alone. */
export const PARTNER_NAME_DECODED_MARKER = "nameEntitiesDecodedAt";

/**
 * A character reference the decoder does not handle ("&nbsp;", "&Amp;").
 * Reported for a human to look at, never rewritten: guessing at it would be
 * a second decoder.
 */
const UNHANDLED_REFERENCE = /&(?:#[xX]?[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/;

export interface PartnerNameDecodePlan {
  /** The decoded name, when it differs from the stored one. */
  name?: string;
  /** The decoded aliases, when any of them differs from the stored one. */
  aliases?: string[];
  before: { name: unknown; aliases: unknown };
}

function decodeValue(value: unknown): unknown {
  if (typeof value !== "string" || !value) return value;
  return decodeHtmlEntities(value) ?? value;
}

/**
 * The rewrite a stored Partner needs, or null when it needs none: already
 * marked, or nothing in its name or aliases decodes to something else.
 * Non-string values are data from old records and are kept as they are.
 */
export function planPartnerNameDecode(
  data: Record<string, unknown> | undefined,
): PartnerNameDecodePlan | null {
  if (!data || data[PARTNER_NAME_DECODED_MARKER] != null) return null;

  const plan: PartnerNameDecodePlan = {
    before: { name: data.name, aliases: data.aliases },
  };

  const decodedName = decodeValue(data.name);
  if (decodedName !== data.name) plan.name = decodedName as string;

  if (Array.isArray(data.aliases)) {
    const decodedAliases = data.aliases.map(decodeValue);
    if (decodedAliases.some((alias, i) => alias !== (data.aliases as unknown[])[i])) {
      plan.aliases = decodedAliases as string[];
    }
  }

  return plan.name === undefined && plan.aliases === undefined ? null : plan;
}

/**
 * Names and aliases still holding a reference after the plan is applied, so
 * the report can list them for a human instead of silently leaving them.
 */
export function unhandledReferences(
  data: Record<string, unknown> | undefined,
  plan: PartnerNameDecodePlan | null,
): string[] {
  if (!data) return [];
  const name = plan?.name ?? data.name;
  const aliases = plan?.aliases ?? (Array.isArray(data.aliases) ? data.aliases : []);
  return [name, ...aliases].filter(
    (v): v is string => typeof v === "string" && UNHANDLED_REFERENCE.test(v),
  );
}
