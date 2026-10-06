/**
 * The entity-name backfill's facts, as the File facts module writes them
 * (#299, #640).
 *
 * Decodes HTML character references (e.g. "&amp;") in the names of the stored
 * counterparty entities (`extractedIssuer.name`, `extractedRecipient.name`)
 * and in the flat `extractedPartner` (#300), on Files written before
 * Extraction decoded them. Only a value derived from what is already on the
 * File is written, never a guess, and a name with no character reference in
 * it (a bare "&" included) comes back byte-identical, so it is left alone.
 * Nothing derived moves: the decoded name is the same name.
 */

import { decodeHtmlEntities } from "../utils/htmlEntities";

/** The stored entity shape, read defensively: these are legacy records. */
type StoredEntity = { name?: unknown } & Record<string, unknown>;

/** The decoded names of a File, or an empty object when every name already decodes to itself. */
export function decodedEntityNameFields(record: Record<string, unknown>): Record<string, unknown> {
  const update: Record<string, unknown> = {};

  const issuerName = decodedName(record.extractedIssuer);
  const recipientName = decodedName(record.extractedRecipient);
  const partnerName = decodedName({ name: record.extractedPartner });

  // The whole entity rather than a dotted path: the entity is a map and only
  // its `name` moves, so spreading keeps every other field exactly as stored.
  if (issuerName !== null) {
    update.extractedIssuer = { ...(record.extractedIssuer as StoredEntity), name: issuerName };
  }
  if (recipientName !== null) {
    update.extractedRecipient = { ...(record.extractedRecipient as StoredEntity), name: recipientName };
  }
  if (partnerName !== null) {
    update.extractedPartner = partnerName;
  }
  return update;
}

/**
 * The decoded name for a stored entity, or null when there is nothing to
 * write: no entity, no string name, or a name that decodes to itself.
 */
function decodedName(entity: unknown): string | null {
  if (!entity || typeof entity !== "object") return null;

  const name = (entity as StoredEntity).name;
  if (typeof name !== "string" || !name) return null;

  const decoded = decodeHtmlEntities(name);
  return decoded === name ? null : decoded;
}
