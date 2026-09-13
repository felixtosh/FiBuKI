/**
 * The Partners page's merge confirmation: what a proposed Merge would move
 * and gain, and whether it needs the separate VAT ID affirmation (#263,
 * semantics in docs/adr/0005-partner-merge-is-one-way.md).
 *
 * This is a preview only — the numbers the user confirms against before the
 * call is made. `functions/src/partners/mergeUserPartners.ts` is the one
 * place the merge itself happens; this module never writes anything and
 * mirrors just enough of its read-only rules (VAT ID normalization, the
 * empty-field fill order) to describe the same operation honestly.
 *
 * Plain data in, plain data out — no React, no Firestore — so it is testable
 * with node --test.
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeVatId(value) {
  return typeof value === "string" ? value.toUpperCase().replace(/\s/g, "") : "";
}

/**
 * Every pair of non-empty, differing VAT IDs across the whole merge set —
 * survivor and losers alike, because two losers disagreeing is the same
 * warning: whichever one the survivor ends up with, the other was wrong.
 * Mirrors `findVatIdConflicts` in mergeUserPartners.ts, so this warns about
 * exactly what the backend will otherwise refuse.
 *
 * @param {ReadonlyArray<{ id: string, name: string, vatId?: string | null }>} partners
 * @returns {Array<{ a: { id: string, name: string, vatId: string }, b: { id: string, name: string, vatId: string } }>}
 */
function findVatIdConflicts(partners) {
  const withVatId = partners
    .map((p) => ({ id: p.id, name: p.name, vatId: normalizeVatId(p.vatId) }))
    .filter((p) => p.vatId !== "");

  const conflicts = [];
  for (let i = 0; i < withVatId.length; i++) {
    for (let j = i + 1; j < withVatId.length; j++) {
      if (withVatId[i].vatId === withVatId[j].vatId) continue;
      conflicts.push({ a: withVatId[i], b: withVatId[j] });
    }
  }
  return conflicts;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isEmptyValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/**
 * Single values the survivor would gain because it holds nothing there yet.
 * Kept to the fields a user reads as "identifying data" on the partner list
 * and detail panel; the full field set the backend fills is wider, but this
 * is a preview of what to expect, not an audit of it.
 */
const GAINABLE_FIELDS = [
  { field: "vatId", label: "VAT ID" },
  { field: "website", label: "website" },
  { field: "address", label: "address" },
];

/**
 * What the survivor would gain from the losers, in the order given — the
 * first loser to hold a value wins, same as the backend's fill rule.
 *
 * @param {import("./merge-preview").MergeGainSource} survivor
 * @param {ReadonlyArray<import("./merge-preview").MergeGainSource & { name: string }>} losers
 * @returns {Array<{ field: string, label: string, fromName: string }>}
 */
function fieldGains(survivor, losers) {
  const gains = [];
  for (const { field, label } of GAINABLE_FIELDS) {
    if (!isEmptyValue(survivor[field])) continue;
    const donor = losers.find((loser) => !isEmptyValue(loser[field]));
    if (donor) gains.push({ field, label, fromName: donor.name });
  }
  return gains;
}

/**
 * How many entries in the losers' lists the survivor's own list does not
 * already hold, by a caller-supplied identity key. Used for aliases, IBANs
 * and email domains, where the count of new entries matters more than which
 * ones they are.
 *
 * @param {ReadonlyArray<unknown> | null | undefined} survivorList
 * @param {ReadonlyArray<ReadonlyArray<unknown> | null | undefined>} loserLists
 * @param {(item: unknown) => string} normalize
 * @returns {number}
 */
function newEntryCount(survivorList, loserLists, normalize) {
  const existing = new Set((survivorList || []).map(normalize));
  const added = new Set();
  for (const list of loserLists) {
    for (const item of list || []) {
      const key = normalize(item);
      if (!existing.has(key)) added.add(key);
    }
  }
  return added.size;
}

module.exports = {
  normalizeVatId,
  findVatIdConflicts,
  isEmptyValue,
  fieldGains,
  newEntryCount,
};
