/**
 * Fold one or more Partners into another because they are the same business
 * (#262, semantics in [ADR-0005](docs/adr/0005-partner-merge-is-one-way.md)).
 *
 * The caller names the survivor and the losers. Nothing here infers which
 * record should live: a Merge cannot be undone, so no heuristic gets to make
 * that call. Several losers go in at once because duplicates arrive in clusters
 * rather than pairs.
 *
 * What the survivor gains: every single value it was missing, filled from the
 * losers in the order given, and a union of every multi-valued identifying
 * collection — aliases, IBANs, email domains, and the learned patterns
 * including the negative signals that record which Transactions and Files the
 * user pulled off a Partner. Each loser's name joins the survivor's aliases:
 * that is the knowledge the duplicate proved, and dropping it would make
 * merging a duplicate destroy the reason it existed. Where the survivor already
 * holds a different value it keeps its own and the loser's is recorded on the
 * Merged Partner rather than dropped.
 *
 * What each loser becomes: a **Merged Partner** — inactive, carrying
 * `mergedInto`, therefore out of the Partner list and out of the match
 * candidate set (both are `isActive == true` queries). It is still read back as
 * itself. A caller holding a stale id has to be told once so it can update; a
 * silent redirect to the survivor teaches it that the stale id is fine forever.
 * Tombstones never chain: merging a survivor onward rewrites every Merged
 * Partner that pointed at it, so a pointer is always one hop from a live
 * Partner and no consumer needs loop detection.
 *
 * What a Merge repoints: Transactions, Files, an Invoice's
 * `recipient.partnerId`, the identity settings document's entities, the Merged
 * Partners that named a loser, and `invoiceFetchQueue` items — browser fetch
 * work that would otherwise come back attributed to a Partner the list no
 * longer shows (#307). Queue items move at every status, as Invoices do: a
 * loser id left on a finished item cannot be told apart from one nobody
 * repointed.
 *
 * Everything else that stores a Partner id is listed below as a deliberate
 * omission, so a reader of this contract can tell a decision from an oversight.
 *
 * What a Merge does NOT do:
 * - It does not re-run the Match. It reports how many unmatched Transactions
 *   the survivor's new identifying data would now hit and leaves the existing
 *   reviewed rematch path (`partner_rematch_report`) to act on that. Silent
 *   re-attribution of bookings is what makes people stop trusting the
 *   operation. Nor does it let a trigger re-run the Match behind its back:
 *   every Partner document written here — survivor, losers, rewritten
 *   tombstones — is stamped with this merge's `mergeWriteId`, which is what
 *   `onPartnerUpdate` reads to stand down (#306, `mergeWriteMarker.ts`).
 * - It does not touch what an issued Invoice froze at issue time. Only the
 *   pointer beside the frozen recipient block moves, for every Invoice status,
 *   because the snapshot is the document of record either way.
 * - It does not touch Notifications. They record events that already happened,
 *   and rewriting them would rewrite history. The same holds for the other
 *   records of something that already ran: `workerRuns` transcripts, `aiUsage`
 *   metadata, and the `searchParams.partnerId` a precision search stamped on
 *   the `transactions/{id}/searches` attempt it logged.
 * - It does not repoint a queued `partner_file_batch` worker request. Its
 *   `triggerContext.partnerId` is accompanied by a prompt naming the loser in
 *   prose, so moving the pointer alone would leave the two disagreeing, and
 *   the work the request actually does is over the `fileIds` it carries —
 *   those moved. Nor does it rewrite `learningQueue.pendingPartners`: a loser
 *   queued for pattern learning drains to a no-op, because the Transactions
 *   the learner would read moved to the survivor.
 * - It does not move `users/{uid}/partnerBatchStates/{partnerId}`, which is
 *   keyed on a Partner id rather than pointing at one; the loser's document
 *   goes idle with the Partner. Nor does it rewrite a queue item's
 *   `invoiceSourceId`, which names an entry inside a Partner rather than a
 *   Partner: that entry travels with the `invoiceSources`/`browserRecipes`
 *   union unless the survivor already holds one for the same url, and a fetch
 *   runs off the item's own `url` either way.
 * - It does not promote the survivor to an identity-synced Partner.
 *   `identitySourceField` is what makes a Partner offer "Edit in Identity"
 *   instead of being edited on the Partner page, so it is not an ordinary
 *   empty-value fill: it travels only where the identity entity that produced
 *   it is itself repointed onto the survivor, which is the same write making
 *   the survivor that entity's Partner (#307). The deprecated
 *   `identityPartnerIds` pointers move without handing one over — they are the
 *   legacy spelling of a pointer, not an entity identity sync maintains.
 * - It does not rewrite `partnerSuggestions` on Transactions or Files, or the
 *   `searchSuggestions.partnerId` cache key. Firestore cannot query an array of
 *   objects by member field, so repointing suggestions means a full scan of
 *   both collections inside a mutation; a suggestion naming a Merged Partner
 *   resolves against the Partner list, which no longer contains it, and the
 *   matcher overwrites it on its next pass. The cache key is deliberately left
 *   stale so the cache invalidates instead of silently surviving the merge.
 */

import { Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { newMergeWriteId, stampMergeWrite } from "./mergeWriteMarker";
import {
  matchTransaction,
  normalizeIban,
  PartnerData,
  TransactionData,
} from "../utils/partner-matcher";

const PARTNERS = "partners";
const TRANSACTIONS = "transactions";
const FILES = "files";
const INVOICES = "invoices";
const INVOICE_FETCH_QUEUE = "invoiceFetchQueue";

const BATCH_SIZE = 500;

/**
 * Duplicates arrive in clusters, not crowds. A ceiling keeps one call's write
 * fan-out bounded and a typo in a generated id list from rewriting an account.
 */
const MAX_LOSERS = 50;

/**
 * `removePartnerFromTransaction` caps this array at 50 on every write, so the
 * union respects the same ceiling — not capping here would only last until the
 * next manual removal truncated it anyway.
 */
const MAX_MANUAL_REMOVALS = 50;

/** Page size and hard ceiling for the rematch preview scan, as the report uses. */
const PREVIEW_PAGE_SIZE = 500;
const PREVIEW_MAX_SCAN = 20000;

// ============================================================================
// Request / response
// ============================================================================

export interface MergeUserPartnersRequest {
  /** The Partner that lives. */
  survivorId: string;
  /** The Partners folded into it. */
  loserIds: string[];
  /**
   * Deliberate affirmation that two non-empty, differing VAT IDs are meant to
   * be merged anyway. Separate from the ordinary confirmation, because a wrong
   * extracted VAT ID is itself a common cause of the duplicate and only the
   * user knows which one is the typo.
   */
  confirmVatIdConflict?: boolean;
}

/** Which of a loser's single values the survivor's own values beat. */
export interface MergeConflictReport {
  partnerId: string;
  fields: string[];
}

export interface MergeUserPartnersResponse {
  success: boolean;
  survivorId: string;
  /** The losers, now Merged Partners, in the order given. */
  mergedPartnerIds: string[];
  /** Names and aliases the survivor did not have before. */
  aliasesAdded: string[];
  repointed: {
    transactions: number;
    files: number;
    invoices: number;
    /** Queued browser invoice-fetch work naming a loser. */
    invoiceFetchQueue: number;
    /** Pointers inside the identity settings document. */
    identityReferences: number;
    /** Merged Partners that pointed at a loser and now point at the survivor. */
    mergedPartners: number;
  };
  /**
   * Which fields conflicted, per loser. The losing values themselves live on
   * the Merged Partner's `mergeConflicts`, where they stay readable without
   * putting Firestore types on the wire.
   */
  conflicts: MergeConflictReport[];
  /**
   * What a rematch WOULD find. Nothing was rematched.
   */
  rematchPreview: {
    /**
     * Unmatched Transactions the survivor matches with its new identifying
     * data and did not match with its old data, minus the ones the merged
     * negative signals veto.
     */
    newlyMatchable: number;
    scanned: number;
    /** True when the scan hit its ceiling, so `newlyMatchable` is a floor. */
    truncated: boolean;
  };
}

// ============================================================================
// Field merge rules
// ============================================================================

type Doc = Record<string, unknown>;

/**
 * Single values the survivor fills from a loser only where its own is empty.
 *
 * `name` is absent on purpose: the survivor's name is the name of the merged
 * business, and each loser's name becomes an alias instead.
 *
 * `identitySourceField` is absent for a different reason: it changes where the
 * survivor is edited, so it moves with the identity entity repoint rather than
 * with an empty slot (#307). See `mergePartnerFields`.
 */
const SINGLE_VALUE_FIELDS = [
  "globalPartnerId",
  "address",
  "country",
  "website",
  "notes",
  "defaultCategoryId",
  "isMyCompany",
  "billingCycle",
  "scoringWeights",
  "resolutionPreference",
] as const;

/**
 * `vatId` does not travel alone. `viesVerified`/`viesVerifiedAt` assert that
 * THAT number was checked against VIES, so moving one without the others would
 * either claim a verification the survivor never had or keep a verification of
 * a number it no longer stores. The group is keyed on `vatId` and moves whole.
 */
const VAT_ID_GROUP = ["vatId", "viesVerified", "viesVerifiedAt"] as const;

/**
 * Multi-valued identifying data, with the identity each collection dedupes on
 * and the timestamp that records when it last changed. Union is first-wins on
 * the key, survivor first: the survivor keeps the entry it already learned and
 * gains only the ones it did not have.
 */
interface CollectionRule {
  field: string;
  key: (item: unknown) => string | null;
  /** Rewrites an entry before it is stored (normalisation for scalar lists). */
  normalize?: (item: unknown) => unknown;
  /** Ceiling, keeping the most recent by `recencyOf`. */
  cap?: { max: number; recencyOf: (item: unknown) => number };
  /** Field to stamp with the merge time when this collection changed. */
  updatedAtField?: string;
}

function asRecord(item: unknown): Doc {
  return item && typeof item === "object" ? (item as Doc) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function millis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const ts = value as { toDate?: () => Date } | null;
  if (ts && typeof ts.toDate === "function") {
    const date = ts.toDate();
    return date instanceof Date && !isNaN(date.getTime()) ? date.getTime() : 0;
  }
  if (typeof value === "number") return value;
  return 0;
}

const COLLECTION_RULES: CollectionRule[] = [
  {
    field: "ibans",
    key: (item) => normalizeIban(text(item)) || null,
    normalize: (item) => normalizeIban(text(item)),
  },
  {
    field: "emailDomains",
    key: (item) => text(item).trim().toLowerCase() || null,
    normalize: (item) => text(item).trim().toLowerCase(),
    updatedAtField: "emailDomainsUpdatedAt",
  },
  {
    field: "learnedPatterns",
    key: (item) => text(asRecord(item).pattern).toLowerCase() || null,
    updatedAtField: "patternsUpdatedAt",
  },
  {
    field: "manualRemovals",
    key: (item) => text(asRecord(item).transactionId) || null,
    cap: { max: MAX_MANUAL_REMOVALS, recencyOf: (item) => millis(asRecord(item).removedAt) },
  },
  {
    field: "manualFileRemovals",
    key: (item) => text(asRecord(item).fileId) || null,
  },
  {
    field: "emailSearchPatterns",
    key: (item) => text(asRecord(item).pattern).toLowerCase() || null,
    updatedAtField: "emailPatternsUpdatedAt",
  },
  {
    field: "fileSourcePatterns",
    key: (item) => {
      const entry = asRecord(item);
      const pattern = text(entry.pattern).toLowerCase();
      if (!pattern) return null;
      return `${text(entry.sourceType)}|${text(entry.integrationId)}|${pattern}`;
    },
    updatedAtField: "fileSourcePatternsUpdatedAt",
  },
  {
    field: "invoiceLinks",
    key: (item) => text(asRecord(item).url) || null,
    updatedAtField: "invoiceLinksUpdatedAt",
  },
  {
    // Deprecated in favour of browserRecipes, but a partner still carrying one
    // would lose it silently otherwise. Keyed on the url, not the random id.
    field: "invoiceSources",
    key: (item) => text(asRecord(item).url) || null,
  },
  {
    // One recipe per domain per partner, so the domain IS the identity.
    field: "browserRecipes",
    key: (item) => text(asRecord(item).domain).toLowerCase() || null,
  },
  {
    field: "categoryMatchRules",
    key: (item) => text(asRecord(item).categoryId) || null,
    updatedAtField: "categoryMatchRulesUpdatedAt",
  },
  {
    field: "categoryManualRemovals",
    key: (item) => {
      const entry = asRecord(item);
      const transactionId = text(entry.transactionId);
      if (!transactionId) return null;
      return `${transactionId}|${text(entry.categoryId)}`;
    },
  },
];

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Structural equality, good enough for the scalars and flat blobs stored here. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function readList(doc: Doc, field: string): unknown[] {
  const value = doc[field];
  return Array.isArray(value) ? value : [];
}

function unionCollection(rule: CollectionRule, lists: unknown[][]): unknown[] | null {
  const seen = new Set<string>();
  let merged: unknown[] = [];
  let changed = false;

  for (let i = 0; i < lists.length; i++) {
    for (const item of lists[i]) {
      const key = rule.key(item);
      if (key === null || seen.has(key)) continue;
      seen.add(key);
      merged.push(rule.normalize ? rule.normalize(item) : item);
      if (i > 0) changed = true;
    }
  }

  // A normalisation that rewrote a survivor entry is a change too, e.g. an
  // IBAN stored with spaces before the write path normalised them away.
  if (!changed && !sameValue(merged, lists[0])) changed = true;
  if (!changed) return null;

  if (rule.cap && merged.length > rule.cap.max) {
    const { max, recencyOf } = rule.cap;
    const newest = [...merged]
      .sort((a, b) => recencyOf(b) - recencyOf(a))
      .slice(0, max);
    const keep = new Set(newest);
    merged = merged.filter((item) => keep.has(item));
  }

  return merged;
}

/**
 * Case-insensitive alias union. Each loser's name joins the list: the
 * acceptance criterion is explicit, so the "is this a meaningful alias" filter
 * the manual edit path applies does not get to drop it. An alias equal to the
 * survivor's own name is skipped — the name already matches.
 */
function mergeAliases(survivor: Doc, losers: Doc[]): { aliases: string[]; added: string[] } {
  const seen = new Set<string>();
  const aliases: string[] = [];
  const added: string[] = [];

  const survivorName = text(survivor.name).trim();
  if (survivorName) seen.add(survivorName.toLowerCase());

  const take = (raw: unknown, isNew: boolean): void => {
    const alias = text(raw).trim();
    if (!alias) return;
    const key = alias.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    aliases.push(alias);
    if (isNew) added.push(alias);
  };

  for (const alias of readList(survivor, "aliases")) take(alias, false);
  for (const loser of losers) {
    take(loser.name, true);
    for (const alias of readList(loser, "aliases")) take(alias, true);
  }

  return { aliases, added };
}

export interface MergedPartnerFields {
  /** What to write on the survivor. Empty when the losers added nothing. */
  survivorUpdates: Doc;
  /** The survivor document as it will read after the merge. */
  mergedSurvivor: Doc;
  /** Per-loser record of the single values the survivor's own value beat. */
  conflictsByLoserId: Map<string, Array<{ field: string; value: unknown; survivorValue: unknown }>>;
  aliasesAdded: string[];
}

/**
 * Merge the Partner documents themselves. Pure: no reads, no writes, no clock
 * beyond the `now` handed in, so the rules are testable on their own.
 *
 * `losers` must carry an `id`, because conflicts are recorded per loser.
 *
 * `identitySourceField` is the marker an identity entity repoint hands over,
 * read from the plan the caller made against the identity settings document.
 * It is the one single value that does not fill from a loser on its own.
 */
export function mergePartnerFields(
  survivor: Doc,
  losers: Array<Doc & { id: string }>,
  now: Timestamp,
  options: { identitySourceField?: string | null } = {}
): MergedPartnerFields {
  const survivorUpdates: Doc = {};
  const mergedSurvivor: Doc = { ...survivor };

  // --- single values: fill where empty, in the order the caller gave ---
  const fillSingle = (field: string, group: readonly string[]): void => {
    if (!isEmptyValue(mergedSurvivor[field])) return;
    for (const loser of losers) {
      if (isEmptyValue(loser[field])) continue;
      for (const member of group) {
        if (loser[member] === undefined) continue;
        survivorUpdates[member] = loser[member];
        mergedSurvivor[member] = loser[member];
      }
      return;
    }
  };

  fillSingle("vatId", VAT_ID_GROUP);
  for (const field of SINGLE_VALUE_FIELDS) fillSingle(field, [field]);

  // The identity marker travels with the entity, never on its own: a survivor
  // that was not identity-synced is not made so by a loser that happened to be
  // (#307). A survivor that already carries one keeps it, as with any conflict.
  if (options.identitySourceField && isEmptyValue(mergedSurvivor.identitySourceField)) {
    survivorUpdates.identitySourceField = options.identitySourceField;
    mergedSurvivor.identitySourceField = options.identitySourceField;
  }

  // --- conflicts: measured against what the survivor ends up holding ---
  const conflictsByLoserId = new Map<
    string,
    Array<{ field: string; value: unknown; survivorValue: unknown }>
  >();
  // `identitySourceField` is not filled from a loser, but where the survivor
  // ends up holding one of its own, a differing loser marker is a value that
  // marker beat, so it is recorded on the Merged Partner like any other. A
  // marker no survivor value beat is not a conflict: it stays readable on the
  // Merged Partner's own document, which is where it already was.
  const conflictFields = ["vatId", ...SINGLE_VALUE_FIELDS, "identitySourceField"];

  for (const loser of losers) {
    const conflicts: Array<{ field: string; value: unknown; survivorValue: unknown }> = [];
    for (const field of conflictFields) {
      const loserValue = loser[field];
      const survivorValue = mergedSurvivor[field];
      if (isEmptyValue(loserValue) || isEmptyValue(survivorValue)) continue;
      if (sameValue(loserValue, survivorValue)) continue;
      conflicts.push({ field, value: loserValue, survivorValue });
    }
    if (conflicts.length > 0) conflictsByLoserId.set(loser.id, conflicts);
  }

  // --- aliases ---
  const { aliases, added } = mergeAliases(survivor, losers);
  if (!sameValue(aliases, readList(survivor, "aliases"))) {
    survivorUpdates.aliases = aliases;
    mergedSurvivor.aliases = aliases;
  }

  // --- the rest of the multi-valued identifying data ---
  for (const rule of COLLECTION_RULES) {
    const lists = [readList(survivor, rule.field), ...losers.map((l) => readList(l, rule.field))];
    if (lists.every((list) => list.length === 0)) continue;

    const merged = unionCollection(rule, lists);
    if (merged === null) continue;

    survivorUpdates[rule.field] = merged;
    mergedSurvivor[rule.field] = merged;
    if (rule.updatedAtField) {
      survivorUpdates[rule.updatedAtField] = now;
      mergedSurvivor[rule.updatedAtField] = now;
    }
  }

  return { survivorUpdates, mergedSurvivor, conflictsByLoserId, aliasesAdded: added };
}

// ============================================================================
// Rematch preview
// ============================================================================

/** The matcher's view of a Partner, built exactly as the matching context does. */
function toMatcherPartner(id: string, doc: Doc): PartnerData {
  return {
    id,
    name: text(doc.name),
    aliases: readList(doc, "aliases") as string[],
    ibans: readList(doc, "ibans") as string[],
    website: doc.website as string | undefined,
    vatId: doc.vatId as string | undefined,
    learnedPatterns: readList(doc, "learnedPatterns") as PartnerData["learnedPatterns"],
    globalPartnerId: (doc.globalPartnerId as string | undefined) || null,
  };
}

/**
 * Count the unmatched Transactions the survivor's NEW identifying data would
 * hit: matched by the merged Partner, not matched by the Partner as it stood,
 * and not vetoed by the merged negative signals. Writes nothing.
 *
 * The difference is what matters. A Transaction the survivor already matched
 * is not something the Merge unlocked, and reporting it would overstate what
 * the reviewed rematch path has to look at.
 */
async function previewNewlyMatchable(
  db: FirebaseFirestore.Firestore,
  userId: string,
  survivorId: string,
  before: Doc,
  after: Doc
): Promise<MergeUserPartnersResponse["rematchPreview"]> {
  const beforePartner = [toMatcherPartner(survivorId, before)];
  const afterPartner = [toMatcherPartner(survivorId, after)];
  const vetoed = new Set(
    readList(after, "manualRemovals").map((entry) => text(asRecord(entry).transactionId))
  );

  let newlyMatchable = 0;
  let scanned = 0;
  let truncated = false;
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;

  for (;;) {
    // No explicit order: Firestore's implicit `__name__` ordering is enough to
    // page on, needs no composite index, and — unlike ordering by `date` —
    // cannot drop a Transaction whose date field is missing.
    let query: FirebaseFirestore.Query = db
      .collection(TRANSACTIONS)
      .where("userId", "==", userId)
      .where("partnerId", "==", null);
    if (cursor) query = query.startAfter(cursor);

    const page = await query.limit(PREVIEW_PAGE_SIZE).get();
    if (page.empty) break;

    for (const doc of page.docs) {
      const data = doc.data();
      scanned++;
      // The write path skips these too: a Transaction resolved by a no-receipt
      // category is not waiting for a Partner, and an over-quota one is not
      // matched at all until the quota is lifted. Counting either would report
      // work the reviewed rematch path could never act on.
      if (data.noReceiptCategoryId) continue;
      if (data.quotaExceeded) continue;
      if (vetoed.has(doc.id)) continue;

      const transaction: TransactionData = {
        id: doc.id,
        partner: (data.partner as string | null) || null,
        partnerIban: (data.partnerIban as string | null) || null,
        name: (data.name as string) || "",
        reference: (data.reference as string | null) || null,
      };

      if (matchTransaction(transaction, afterPartner, []).length === 0) continue;
      if (matchTransaction(transaction, beforePartner, []).length > 0) continue;
      newlyMatchable++;
    }

    if (page.size < PREVIEW_PAGE_SIZE) break;
    if (scanned >= PREVIEW_MAX_SCAN) {
      truncated = true;
      break;
    }
    cursor = page.docs[page.docs.length - 1];
  }

  return { newlyMatchable, scanned, truncated };
}

// ============================================================================
// Repointing
// ============================================================================

async function commitInChunks(
  db: FirebaseFirestore.Firestore,
  writes: Array<{ ref: FirebaseFirestore.DocumentReference; updates: Doc }>
): Promise<void> {
  for (let i = 0; i < writes.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const write of writes.slice(i, i + BATCH_SIZE)) {
      batch.update(write.ref, write.updates);
    }
    await batch.commit();
  }
}

/**
 * Repoint a collection whose Partner pointer is a top-level `partnerId`.
 *
 * `alongside` carries whatever else that collection stores next to the
 * pointer. Transactions and Files re-state `partnerType` and their
 * `updatedAt`; an `invoiceFetchQueue` item holds neither field, and inventing
 * them on a queue the browser extension reads would be a schema change this
 * operation has no business making.
 */
async function repointByPartnerId(
  db: FirebaseFirestore.Firestore,
  collection: string,
  userId: string,
  loserId: string,
  survivorId: string,
  alongside: Doc
): Promise<number> {
  const snapshot = await db
    .collection(collection)
    .where("userId", "==", userId)
    .where("partnerId", "==", loserId)
    .get();

  // The pointer moves; how the Partner was matched and how confidently does
  // not. A manual assignment to a duplicate is still a manual assignment.
  await commitInChunks(
    db,
    snapshot.docs.map((doc) => ({
      ref: doc.ref,
      updates: { partnerId: survivorId, ...alongside },
    }))
  );

  return snapshot.size;
}

/**
 * Repoint Invoices. `recipient` is rewritten as a whole object with only
 * `partnerId`/`partnerType` changed, so what the Invoice froze at issue time —
 * the recipient's name, VAT ID and address — provably survives the merge.
 */
async function repointInvoices(
  db: FirebaseFirestore.Firestore,
  userId: string,
  loserId: string,
  survivorId: string,
  now: Timestamp
): Promise<number> {
  const snapshot = await db
    .collection(INVOICES)
    .where("userId", "==", userId)
    .where("recipient.partnerId", "==", loserId)
    .get();

  await commitInChunks(
    db,
    snapshot.docs.map((doc) => ({
      ref: doc.ref,
      updates: {
        recipient: {
          ...asRecord(doc.data().recipient),
          partnerId: survivorId,
          partnerType: "user",
        },
        updatedAt: now,
      },
    }))
  );

  return snapshot.size;
}

interface IdentityRepointPlan {
  /** Field updates for the identity settings document; empty when none moved. */
  updates: Doc;
  /** How many pointers move. */
  repointed: number;
  /**
   * The marker the survivor inherits because it is now that identity entity's
   * Partner — `"personalEntity"` or `company:{id}`, exactly what
   * `syncIdentityPartners` writes — or null when no entity moved. It does not
   * depend on the loser having carried one: identity sync writes through the
   * entity's `partnerId`, so a survivor an entity now names is synced whether
   * or not it says so, and the marker is what makes the UI honest about it.
   * Only the entities identity sync maintains hand one over; the deprecated
   * `identityPartnerIds` pointers move without minting a legacy marker.
   */
  identitySourceField: string | null;
}

/**
 * Plan the identity settings document's repoint: the entity that carries the
 * Partner link, plus the two deprecated pointers the identity page and the
 * partner table still read. Leaving those stale would silently un-mark "this
 * is my company" by pointing it at a record nothing lists.
 *
 * Planned rather than done, because the survivor's single update has to carry
 * the marker this read decides on, and that write comes first (#307).
 */
async function planIdentityRepoint(
  db: FirebaseFirestore.Firestore,
  userId: string,
  loserIds: Set<string>,
  survivorId: string
): Promise<IdentityRepointPlan> {
  const empty: IdentityRepointPlan = { updates: {}, repointed: 0, identitySourceField: null };

  const snapshot = await db.collection(`users/${userId}/settings`).doc("userData").get();
  if (!snapshot.exists) return empty;

  const data = snapshot.data() as Doc;
  const updates: Doc = {};
  let repointed = 0;
  let identitySourceField: string | null = null;

  const repointEntity = (entity: unknown, sourceField: string | null): Doc | null => {
    const record = asRecord(entity);
    if (!loserIds.has(text(record.partnerId))) return null;
    repointed++;
    // First entity wins, so a survivor that swallows two identity Partners at
    // once is marked for one of them rather than for whichever came last.
    if (identitySourceField === null && sourceField) identitySourceField = sourceField;
    return { ...record, partnerId: survivorId };
  };

  const personal = repointEntity(data.personalEntity, "personalEntity");
  if (personal) updates.personalEntity = personal;

  const companies = data.companies;
  if (Array.isArray(companies)) {
    let anyChanged = false;
    const next = companies.map((company) => {
      // An entity with no id cannot be named by a marker; it still repoints.
      const companyId = text(asRecord(company).id);
      const repointedCompany = repointEntity(company, companyId ? `company:${companyId}` : null);
      if (!repointedCompany) return company;
      anyChanged = true;
      return repointedCompany;
    });
    if (anyChanged) updates.companies = next;
  }

  const markedAsMe = data.markedAsMe;
  if (Array.isArray(markedAsMe) && markedAsMe.some((id) => loserIds.has(text(id)))) {
    const next: string[] = [];
    for (const id of markedAsMe) {
      const mapped = loserIds.has(text(id)) ? survivorId : text(id);
      if (mapped && !next.includes(mapped)) next.push(mapped);
    }
    repointed += markedAsMe.filter((id) => loserIds.has(text(id))).length;
    updates.markedAsMe = next;
  }

  const legacy = asRecord(data.identityPartnerIds);
  const legacyNext: Doc = { ...legacy };
  let legacyChanged = false;
  for (const key of ["name", "companyName"]) {
    if (loserIds.has(text(legacy[key]))) {
      legacyNext[key] = survivorId;
      legacyChanged = true;
      repointed++;
    }
  }
  if (legacyChanged) updates.identityPartnerIds = legacyNext;

  if (Object.keys(updates).length === 0) return empty;

  return { updates, repointed, identitySourceField };
}

/** Write what `planIdentityRepoint` worked out. */
async function applyIdentityRepoint(
  db: FirebaseFirestore.Firestore,
  userId: string,
  plan: IdentityRepointPlan,
  now: Timestamp
): Promise<number> {
  if (Object.keys(plan.updates).length === 0) return 0;

  await db
    .collection(`users/${userId}/settings`)
    .doc("userData")
    .update({ ...plan.updates, updatedAt: now });

  return plan.repointed;
}

/** Rewrite every Merged Partner that pointed at a loser to point at the survivor. */
async function rewriteChainedTombstones(
  db: FirebaseFirestore.Firestore,
  userId: string,
  loserId: string,
  survivorId: string,
  now: Timestamp,
  mergeWriteId: string
): Promise<number> {
  const snapshot = await db
    .collection(PARTNERS)
    .where("userId", "==", userId)
    .where("mergedInto", "==", loserId)
    .get();

  await commitInChunks(
    db,
    snapshot.docs.map((doc) => {
      const updates: Doc = { mergedInto: survivorId, updatedAt: now };
      stampMergeWrite(updates, mergeWriteId);
      return { ref: doc.ref, updates };
    })
  );

  return snapshot.size;
}

// ============================================================================
// The operation
// ============================================================================

function normalizeVatId(value: unknown): string {
  return text(value).toUpperCase().replace(/\s/g, "");
}

/**
 * Every pair of non-empty, differing VAT IDs across the whole merge set — not
 * just survivor against loser. Two losers disagreeing is the same warning:
 * whichever the survivor ends up with, one of them is wrong.
 */
function findVatIdConflicts(
  partners: Array<{ id: string; doc: Doc }>
): Array<{ partnerId: string; vatId: string; otherPartnerId: string; otherVatId: string }> {
  const withVatId = partners
    .map((partner) => ({ id: partner.id, vatId: normalizeVatId(partner.doc.vatId) }))
    .filter((partner) => partner.vatId !== "");

  const conflicts: Array<{
    partnerId: string;
    vatId: string;
    otherPartnerId: string;
    otherVatId: string;
  }> = [];

  for (let i = 0; i < withVatId.length; i++) {
    for (let j = i + 1; j < withVatId.length; j++) {
      if (withVatId[i].vatId === withVatId[j].vatId) continue;
      conflicts.push({
        partnerId: withVatId[i].id,
        vatId: withVatId[i].vatId,
        otherPartnerId: withVatId[j].id,
        otherVatId: withVatId[j].vatId,
      });
    }
  }

  return conflicts;
}

/**
 * Internal implementation, so the Partners page callable and the tool surface
 * run the same operation rather than two that drift.
 */
export async function mergeUserPartnersInternal(
  db: FirebaseFirestore.Firestore,
  userId: string,
  request: MergeUserPartnersRequest
): Promise<MergeUserPartnersResponse> {
  const survivorId = text(request?.survivorId).trim();
  if (!survivorId) {
    throw new HttpsError("invalid-argument", "survivorId is required");
  }
  if (!Array.isArray(request?.loserIds) || request.loserIds.length === 0) {
    throw new HttpsError("invalid-argument", "loserIds must name at least one partner");
  }

  const loserIds: string[] = [];
  for (const raw of request.loserIds) {
    const loserId = text(raw).trim();
    if (!loserId) {
      throw new HttpsError("invalid-argument", "loserIds contains an empty partner id");
    }
    if (loserId === survivorId) {
      throw new HttpsError("invalid-argument", "A partner cannot be merged into itself");
    }
    if (!loserIds.includes(loserId)) loserIds.push(loserId);
  }
  if (loserIds.length > MAX_LOSERS) {
    throw new HttpsError(
      "invalid-argument",
      `A merge takes at most ${MAX_LOSERS} losers; ${loserIds.length} were named`
    );
  }

  // --- load and check ownership ---
  const refs = [survivorId, ...loserIds].map((id) => db.collection(PARTNERS).doc(id));
  const snapshots = await Promise.all(refs.map((ref) => ref.get()));

  const docs: Doc[] = snapshots.map((snapshot, index) => {
    const id = index === 0 ? survivorId : loserIds[index - 1];
    if (!snapshot.exists) {
      throw new HttpsError("not-found", `Partner ${id} not found`);
    }
    const data = snapshot.data() as Doc;
    if (data.userId !== userId) {
      throw new HttpsError("permission-denied", "Access denied");
    }
    return data;
  });

  const survivorDoc = docs[0];
  const loserDocs = loserIds.map((id, index) => ({ ...docs[index + 1], id }));

  // A Merged Partner may be a loser again — it has no references left to move —
  // but never a survivor. Merging into one would build the chain ADR-0005
  // forbids and hide the result behind a tombstone.
  if (!isEmptyValue(survivorDoc.mergedInto)) {
    throw new HttpsError(
      "failed-precondition",
      `Partner ${survivorId} is a Merged Partner (merged into ${text(survivorDoc.mergedInto)}); ` +
        "merge into the survivor instead"
    );
  }

  // --- the VAT ID warning, which is a warning and not a wall ---
  const vatIdConflicts = findVatIdConflicts([
    { id: survivorId, doc: survivorDoc },
    ...loserDocs.map((loser) => ({ id: loser.id, doc: loser })),
  ]);
  if (vatIdConflicts.length > 0 && request.confirmVatIdConflict !== true) {
    const described = vatIdConflicts
      .map((c) => `${c.partnerId}=${c.vatId} vs ${c.otherPartnerId}=${c.otherVatId}`)
      .join("; ");
    throw new HttpsError(
      "failed-precondition",
      "These partners hold different VAT IDs " +
        `(${described}). Set confirmVatIdConflict to merge them anyway.`,
      { vatIdConflicts }
    );
  }

  // Read before anything is written: the survivor's single update carries the
  // identity marker this plan decides on, so the plan has to exist first.
  const identityPlan = await planIdentityRepoint(db, userId, new Set(loserIds), survivorId);

  const now = Timestamp.now();
  // Every Partner write below carries this id, so `onPartnerUpdate` recognises
  // all of them as this merge's own and re-runs no file matching (#306).
  const mergeWriteId = newMergeWriteId();
  const { survivorUpdates, mergedSurvivor, conflictsByLoserId, aliasesAdded } =
    mergePartnerFields(survivorDoc, loserDocs, now, {
      identitySourceField: identityPlan.identitySourceField,
    });

  // --- write order: the survivor gains first, the losers become tombstones
  // last. A crash in between leaves visible duplicates whose references have
  // already moved, which is re-runnable; the other order would leave live
  // references aimed at a Partner nothing lists.
  survivorUpdates.updatedAt = now;
  stampMergeWrite(survivorUpdates, mergeWriteId);
  await refs[0].update(survivorUpdates);

  const repointed = {
    transactions: 0,
    files: 0,
    invoices: 0,
    invoiceFetchQueue: 0,
    identityReferences: 0,
    mergedPartners: 0,
  };

  const alongsidePointer = { partnerType: "user", updatedAt: now };

  for (const loser of loserDocs) {
    repointed.transactions += await repointByPartnerId(
      db, TRANSACTIONS, userId, loser.id, survivorId, alongsidePointer
    );
    repointed.files += await repointByPartnerId(
      db, FILES, userId, loser.id, survivorId, alongsidePointer
    );
    repointed.invoices += await repointInvoices(db, userId, loser.id, survivorId, now);
    repointed.invoiceFetchQueue += await repointByPartnerId(
      db, INVOICE_FETCH_QUEUE, userId, loser.id, survivorId, {}
    );
    repointed.mergedPartners += await rewriteChainedTombstones(
      db, userId, loser.id, survivorId, now, mergeWriteId
    );
  }

  repointed.identityReferences = await applyIdentityRepoint(db, userId, identityPlan, now);

  const tombstoneWrites = loserDocs.map((loser) => {
    const conflicts = conflictsByLoserId.get(loser.id);
    const updates: Doc = {
      isActive: false,
      mergedInto: survivorId,
      mergedAt: now,
      updatedAt: now,
    };
    stampMergeWrite(updates, mergeWriteId);
    if (conflicts && conflicts.length > 0) {
      // Appended, so a Partner merged away twice keeps both rounds.
      const existing = readList(loser, "mergeConflicts");
      updates.mergeConflicts = [...existing, ...conflicts];
    }
    return { ref: db.collection(PARTNERS).doc(loser.id), updates };
  });
  await commitInChunks(db, tombstoneWrites);

  const rematchPreview = await previewNewlyMatchable(
    db,
    userId,
    survivorId,
    survivorDoc,
    mergedSurvivor
  );

  console.log(`[mergeUserPartners] Merged ${loserIds.length} partner(s) into ${survivorId}`, {
    userId,
    loserIds,
    repointed,
    aliasesAdded: aliasesAdded.length,
    newlyMatchable: rematchPreview.newlyMatchable,
  });

  return {
    success: true,
    survivorId,
    mergedPartnerIds: loserIds,
    aliasesAdded,
    repointed,
    conflicts: [...conflictsByLoserId.entries()].map(([partnerId, conflicts]) => ({
      partnerId,
      fields: conflicts.map((conflict) => conflict.field),
    })),
    rematchPreview,
  };
}

export const mergeUserPartnersCallable = createCallable<
  MergeUserPartnersRequest,
  MergeUserPartnersResponse
>(
  {
    name: "mergeUserPartners",
    // The repointing fans out over four collections and the preview scans the
    // unmatched transactions, so this is closer to deleteUserPartner's budget
    // than to an ordinary field edit.
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async (ctx, request) => mergeUserPartnersInternal(ctx.db, ctx.userId, request)
);
