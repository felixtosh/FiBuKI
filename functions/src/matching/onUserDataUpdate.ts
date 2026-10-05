/**
 * Cloud Function: On User Data Update
 *
 * Triggered when user data (settings/userData) is updated.
 *
 * 1. Identity Partner Sync:
 *    For each identity entity (personalEntity + companies[]), automatically
 *    creates/updates "identity partners" that represent the user's own entities.
 *    These partners have identitySourceField set and auto-sync.
 *
 * 2. Invoice Direction Recalculation:
 *    Re-calculates invoice direction and counterparty for files that have
 *    extractedIssuer or extractedRecipient entities.
 *
 * This ensures that when a user adds/changes their:
 * - personalEntity (name, vatId, ibans, aliases)
 * - companies[] (name, vatId, ibans, aliases)
 * - ownEmails
 *
 * All their files are re-evaluated to correctly determine:
 * - Invoice direction (incoming vs outgoing)
 * - Which party is the counterparty (extractedPartner)
 * - Which user account was matched (matchedUserAccount)
 *
 * The sweep accounts for every File it reads: one named outcome each, and a
 * run summary stored at `users/{userId}/directionSweeps/{runId}` that says
 * whether the run covered the corpus. See `invoiceDirectionSweepReport.ts`
 * for why a count of "skipped" on its own was not enough (#158).
 *
 * What a File's re-derivation writes is the File facts module's decision
 * (#640): a direction the User set by hand is kept, with the counterparty it
 * chose, and named in the run summary as kept; the derived fields move with
 * the facts. The sweep writes the decisions in batches of its own.
 */

import { onDocumentUpdated, onDocumentCreated } from "firebase-functions/v2/firestore";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { ExtractedEntity } from "../types/extraction";
import { determineCounterparty, type InvoiceDirection } from "../utils/identity-matcher";
import { syncDocumentationStateForTransactions } from "../documents/syncDocumentationState";
import { readLinkedTransactions } from "../documents/syncDirectionReview";
import { decideFactChange } from "../fileFacts/factChange";
import { decodeHtmlEntities } from "../utils/htmlEntities";
import {
  SweepLedger,
  commitSweepWrites,
  formatSweepSummary,
  persistSweepSummary,
  type PlannedFileWrite,
} from "./invoiceDirectionSweepReport";

const db = getFirestore();

// === Configuration ===

const CONFIG = {
  /** Files read per query page while scanning the candidate set. */
  PAGE_SIZE: 500,
  /**
   * Hard ceiling on Files read in one run. Reaching it does not truncate the
   * report: the run records `scanCeilingReached` and reports itself
   * incomplete, because the Files past it were never candidates at all.
   */
  MAX_FILES_SCANNED: 20000,
  /** Documents per batched commit. */
  MAX_BATCH_SIZE: 500,
  /** Region for the function */
  REGION: "europe-west1",
};

// === Types ===

/** Identity entity (personal or company) */
interface IdentityEntity {
  id: string;
  type: "person" | "company";
  name: string;
  aliases: string[];
  vatId?: string;
  ibans: string[];
  partnerId?: string;
  order: number;
  createdAt: FirebaseFirestore.Timestamp;
}

/** Legacy identity partner ID mapping */
interface IdentityPartnerIds {
  name?: string;
  companyName?: string;
}

/** User data structure (supports both new and legacy formats) */
interface UserData {
  // New format
  personalEntity?: IdentityEntity;
  companies?: IdentityEntity[];

  // Legacy format (deprecated)
  name?: string;
  companyName?: string;
  aliases?: string[];
  vatIds?: string[];
  ibans?: string[];
  identityPartnerIds?: IdentityPartnerIds;
  markedAsMe?: string[];
}

// === Identity Partner Sync ===

type IdentitySourceField = "personalEntity" | `company:${string}`;

/**
 * Sync identity partners for all entities (personalEntity + companies[]).
 * Creates new partners, updates existing ones, and deletes partners for removed companies.
 */
async function syncIdentityPartners(
  userId: string,
  beforeData: FirebaseFirestore.DocumentData,
  afterData: FirebaseFirestore.DocumentData
): Promise<void> {
  const now = Timestamp.now();
  const updates: Record<string, unknown> = {};

  // === Sync Personal Entity ===
  const beforePersonal = beforeData.personalEntity as IdentityEntity | undefined;
  const afterPersonal = afterData.personalEntity as IdentityEntity | undefined;

  if (afterPersonal?.name?.trim()) {
    const personalResult = await syncEntityPartner(
      userId,
      "personalEntity",
      afterPersonal,
      beforePersonal,
      now
    );

    if (personalResult.partnerId && personalResult.partnerId !== afterPersonal.partnerId) {
      updates["personalEntity.partnerId"] = personalResult.partnerId;
    }
  }

  // === Sync Company Entities ===
  const beforeCompanies = (beforeData.companies || []) as IdentityEntity[];
  const afterCompanies = (afterData.companies || []) as IdentityEntity[];

  // Build map of before companies by ID
  const beforeCompanyMap = new Map<string, IdentityEntity>();
  for (const c of beforeCompanies) {
    if (c.id) beforeCompanyMap.set(c.id, c);
  }

  // Sync each after company
  const updatedCompanies: IdentityEntity[] = [];
  for (let i = 0; i < afterCompanies.length; i++) {
    const company = afterCompanies[i];
    if (!company.id) continue;

    const beforeCompany = beforeCompanyMap.get(company.id);
    const sourceField: IdentitySourceField = `company:${company.id}`;

    if (company.name?.trim()) {
      const result = await syncEntityPartner(
        userId,
        sourceField,
        company,
        beforeCompany,
        now
      );

      if (result.partnerId && result.partnerId !== company.partnerId) {
        // Track update to company's partnerId
        updatedCompanies.push({ ...company, partnerId: result.partnerId });
      } else {
        updatedCompanies.push(company);
      }
    } else {
      updatedCompanies.push(company);
    }

    // Remove from before map (processed)
    beforeCompanyMap.delete(company.id);
  }

  // Check for any companies that were updated with new partnerIds
  const companiesNeedUpdate = afterCompanies.some((c, i) =>
    updatedCompanies[i]?.partnerId !== c.partnerId
  );
  if (companiesNeedUpdate) {
    updates["companies"] = updatedCompanies;
  }

  // === Delete Partners for Removed Companies ===
  for (const [companyId, removedCompany] of beforeCompanyMap) {
    if (removedCompany.partnerId) {
      console.log(`[syncIdentityPartners] Company ${companyId} removed, deleting partner ${removedCompany.partnerId}`);
      await deleteIdentityPartner(userId, removedCompany.partnerId);
    }
  }

  // === Apply Updates ===
  if (Object.keys(updates).length > 0) {
    const userDataRef = db.doc(`users/${userId}/settings/userData`);
    await userDataRef.update({
      ...updates,
      updatedAt: now,
    });
    console.log(`[syncIdentityPartners] Updated userData:`, Object.keys(updates));
  }
}

/**
 * Sync a single entity's partner (create, update, or skip).
 */
async function syncEntityPartner(
  userId: string,
  sourceField: IdentitySourceField,
  entity: IdentityEntity,
  beforeEntity: IdentityEntity | undefined,
  now: FirebaseFirestore.Timestamp
): Promise<{ partnerId?: string }> {
  const trimmedName = entity.name?.trim() || "";
  const beforeName = beforeEntity?.name?.trim() || "";
  const existingPartnerId = entity.partnerId;

  // Skip if no name
  if (!trimmedName) {
    return {};
  }

  // Skip if nothing changed (name, vatId, ibans, aliases)
  if (beforeEntity && existingPartnerId) {
    const nameUnchanged = trimmedName === beforeName;
    const vatIdUnchanged = (entity.vatId || "") === (beforeEntity.vatId || "");
    const ibansUnchanged = JSON.stringify(entity.ibans || []) === JSON.stringify(beforeEntity.ibans || []);
    const aliasesUnchanged = JSON.stringify(entity.aliases || []) === JSON.stringify(beforeEntity.aliases || []);

    if (nameUnchanged && vatIdUnchanged && ibansUnchanged && aliasesUnchanged) {
      return { partnerId: existingPartnerId };
    }
  }

  console.log(`[syncIdentityPartners] Entity ${sourceField} changed: "${beforeName}" -> "${trimmedName}"`);

  if (existingPartnerId) {
    // Update existing partner
    const partnerRef = db.collection("partners").doc(existingPartnerId);
    const partnerSnap = await partnerRef.get();

    if (partnerSnap.exists && partnerSnap.data()?.userId === userId) {
      await partnerRef.update({
        name: trimmedName,
        vatId: entity.vatId || null,
        ibans: entity.ibans || [],
        aliases: entity.aliases || [],
        updatedAt: now,
      });
      console.log(`[syncIdentityPartners] Updated partner ${existingPartnerId} for ${sourceField}`);
      return { partnerId: existingPartnerId };
    } else {
      // Partner doesn't exist or wrong user, create new one
      const newPartnerId = await createIdentityPartner(userId, sourceField, entity, now);
      return { partnerId: newPartnerId };
    }
  } else {
    // Create new partner
    const newPartnerId = await createIdentityPartner(userId, sourceField, entity, now);
    return { partnerId: newPartnerId };
  }
}

/**
 * Create a new identity partner from an entity
 */
async function createIdentityPartner(
  userId: string,
  sourceField: IdentitySourceField,
  entity: IdentityEntity,
  now: FirebaseFirestore.Timestamp
): Promise<string> {
  const newPartner: Record<string, unknown> = {
    userId,
    name: entity.name.trim(),
    aliases: entity.aliases || [],
    address: null,
    country: null,
    vatId: entity.vatId || null,
    ibans: entity.ibans || [],
    website: null,
    notes: null,
    defaultCategoryId: null,
    identitySourceField: sourceField,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    createdBy: "identity_sync",
  };

  const docRef = await db.collection("partners").add(newPartner);
  console.log(`[syncIdentityPartners] Created identity partner ${docRef.id} for ${sourceField}: "${entity.name}"`);
  return docRef.id;
}

/**
 * Delete an identity partner
 */
async function deleteIdentityPartner(
  userId: string,
  partnerId: string
): Promise<void> {
  const partnerRef = db.collection("partners").doc(partnerId);
  const partnerSnap = await partnerRef.get();

  if (partnerSnap.exists && partnerSnap.data()?.userId === userId) {
    await partnerRef.delete();
    console.log(`[syncIdentityPartners] Deleted partner ${partnerId}`);
  }
}

// === Helper Functions ===

/**
 * Check if identity entities changed
 */
function hasIdentityEntitiesChanged(
  before: FirebaseFirestore.DocumentData,
  after: FirebaseFirestore.DocumentData
): boolean {
  // Check personal entity
  const beforePersonal = before.personalEntity as IdentityEntity | undefined;
  const afterPersonal = after.personalEntity as IdentityEntity | undefined;

  if (JSON.stringify(beforePersonal || {}) !== JSON.stringify(afterPersonal || {})) {
    return true;
  }

  // Check companies
  const beforeCompanies = (before.companies || []) as IdentityEntity[];
  const afterCompanies = (after.companies || []) as IdentityEntity[];

  if (JSON.stringify(beforeCompanies) !== JSON.stringify(afterCompanies)) {
    return true;
  }

  return false;
}

/**
 * Check if user data matching-relevant fields changed (supports both new and legacy formats)
 */
function hasMatchingFieldsChanged(
  before: FirebaseFirestore.DocumentData,
  after: FirebaseFirestore.DocumentData
): boolean {
  // New format: check identity entities
  if (hasIdentityEntitiesChanged(before, after)) return true;

  // Legacy format: Name changed
  if (before.name !== after.name) return true;

  // Legacy format: Company name changed
  if (before.companyName !== after.companyName) return true;

  // Legacy format: Aliases changed
  if (JSON.stringify(before.aliases || []) !== JSON.stringify(after.aliases || [])) return true;

  // Legacy format: VAT IDs changed
  if (JSON.stringify(before.vatIds || []) !== JSON.stringify(after.vatIds || [])) return true;

  // Legacy format: IBANs changed
  if (JSON.stringify(before.ibans || []) !== JSON.stringify(after.ibans || [])) return true;

  // Own emails changed
  if (JSON.stringify(before.ownEmails || []) !== JSON.stringify(after.ownEmails || [])) return true;

  return false;
}

/**
 * Fetch IBANs from user's connected bank accounts (sources)
 */
async function getSourceIbans(userId: string): Promise<string[]> {
  try {
    const sourcesSnapshot = await db
      .collection("sources")
      .where("userId", "==", userId)
      .where("isActive", "==", true)
      .get();

    return sourcesSnapshot.docs
      .map((doc) => doc.data().iban as string | undefined)
      .filter((iban): iban is string => !!iban)
      .map((iban) => iban.toUpperCase().replace(/\s/g, ""));
  } catch (error) {
    console.warn("[SourceIbans] Failed to fetch source IBANs:", error);
    return [];
  }
}

// === Invoice Direction Sweep ===

/**
 * A stored entity with its name decoded (#299). Returns the entity unchanged
 * when there is nothing to decode, so an already-decoded record keeps its
 * identity and the sweep's skip comparison is untouched.
 */
function decodeEntityName(entity: ExtractedEntity | null): ExtractedEntity | null {
  // `name` comes off a stored document, so it is data: a record written by an
  // older path can hold a number, an object, anything. decodeHtmlEntities calls
  // .replace on it, so guard the type here rather than letting a malformed
  // record throw from inside a sweep.
  if (typeof entity?.name !== "string" || !entity.name) return entity;
  const decoded = decodeHtmlEntities(entity.name);
  return decoded === entity.name ? entity : { ...entity, name: decoded };
}


/**
 * Re-derive one File, and either plan its write or record why it has none.
 *
 * Every path out of here records exactly one outcome, the throwing one
 * included: before #158 a derivation that threw took the rest of the run with
 * it, and the Files it never reached kept their pre-run `updatedAt` with
 * nothing anywhere saying so.
 */
async function planFileSweep(
  fileDoc: FirebaseFirestore.QueryDocumentSnapshot,
  userData: UserData,
  sourceIbans: string[],
  ledger: SweepLedger,
  planned: PlannedFileWrite[],
  at: Timestamp
): Promise<void> {
  const fileData = fileDoc.data();

  // Extraction has not finished, so extractedIssuer/extractedRecipient are not
  // facts yet. This used to be a `where` clause, which made such a File
  // invisible to the run rather than skipped by it.
  if (fileData.extractionComplete !== true) {
    ledger.record(fileDoc.id, "extraction-incomplete");
    return;
  }

  // isNotInvoice can be false, null or undefined; only an explicit true means
  // the user has said this document carries no direction.
  if (fileData.isNotInvoice === true) {
    ledger.record(fileDoc.id, "not-an-invoice");
    return;
  }

  const storedIssuer = fileData.extractedIssuer as ExtractedEntity | null;
  const storedRecipient = fileData.extractedRecipient as ExtractedEntity | null;

  // Nothing was read off either side of the document, so there is nothing to
  // compare the identity against.
  if (!storedIssuer && !storedRecipient) {
    ledger.record(fileDoc.id, "no-entities");
    return;
  }

  try {
    // #299/#336: decode BEFORE the match, not after it. This sweep both
    // MATCHES these names against the user's identity and rewrites
    // extractedPartner from them, so a record still holding "AL&amp;FA Taxi KG"
    // must be compared as "AL&FA Taxi KG" or it reads as somebody else.
    // Decoding only the result fixed the string that gets stored and left the
    // comparison wrong.
    //
    // Inside the try on purpose: decoding reads a stored value, and this
    // function's contract is that every File gets exactly one outcome. A throw
    // out here would take the rest of the run with it, which is the defect
    // #158 exists to close.
    const issuer = decodeEntityName(storedIssuer);
    const recipient = decodeEntityName(storedRecipient);

    const result = determineCounterparty(issuer, recipient, userData, sourceIbans);

    // The File facts module decides what of the derivation is written (#640):
    // a direction the User set by hand is kept, and so is the counterparty it
    // chose. Asked first without the connected Transactions, which only the
    // direction review reads, so a File with nothing to write costs no read.
    const change = {
      origin: "identity-sweep" as const,
      derived: {
        invoiceDirection: result.invoiceDirection,
        matchedUserAccount: result.matchedUserAccount,
        recipientIdentityMatch: result.recipientIdentityMatch,
        counterparty: result.counterparty,
      },
      at,
    };
    let outcome = decideFactChange({ record: fileData, linkedTransactions: [] }, change);
    if (outcome.refused) throw new Error(outcome.message);

    if (outcome.keptDirection) {
      ledger.kept(fileDoc.id, outcome.keptDirection.stored as InvoiceDirection, result.invoiceDirection);
    }

    // The direction the File holds after this run: a kept one stays.
    const direction = (outcome.keptDirection?.stored ?? result.invoiceDirection) as InvoiceDirection;

    if (Object.keys(outcome.update).length === 0) {
      ledger.record(fileDoc.id, "already-correct", { direction });
      return;
    }

    const transactionIds = (fileData.transactionIds as string[] | undefined) ?? [];
    if (transactionIds.length > 0) {
      const linkedTransactions = await readLinkedTransactions(db, transactionIds);
      outcome = decideFactChange({ record: fileData, linkedTransactions }, change);
      if (outcome.refused) throw new Error(outcome.message);
    }

    planned.push({
      ref: fileDoc.ref,
      fileId: fileDoc.id,
      updates: outcome.update,
      direction,
      affectedTransactionIds: outcome.followUps.flatMap((followUp) =>
        followUp.kind === "sync-documentation-state" ? followUp.transactionIds : []
      ),
    });
  } catch (error) {
    ledger.record(fileDoc.id, "evaluation-failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// === Main Function ===

export const onUserDataUpdate = onDocumentUpdated(
  {
    document: "users/{userId}/settings/userData",
    region: CONFIG.REGION,
    memory: "512MiB",
    timeoutSeconds: 300,
  },
  async (event) => {
    const userId = event.params.userId;
    const beforeData = event.data?.before.data();
    const afterData = event.data?.after.data();

    if (!beforeData || !afterData) {
      console.log(`[onUserDataUpdate] No data for user ${userId}`);
      return;
    }

    // Sync identity partners if any identity entity changed
    const identityChanged = hasIdentityEntitiesChanged(beforeData, afterData);
    // Also check legacy fields for backward compatibility
    const nameChanged = beforeData.name !== afterData.name;
    const companyNameChanged = beforeData.companyName !== afterData.companyName;

    if (identityChanged || nameChanged || companyNameChanged) {
      console.log(`[onUserDataUpdate] Identity fields changed for ${userId}, syncing partners...`);
      await syncIdentityPartners(userId, beforeData, afterData);
    }

    // Check if matching-relevant fields changed
    if (!hasMatchingFieldsChanged(beforeData, afterData)) {
      console.log(`[onUserDataUpdate] No matching-relevant fields changed for user ${userId}`);
      return;
    }

    console.log(`[onUserDataUpdate] User data changed for ${userId}, re-calculating files...`);

    const userData = afterData as UserData;

    // Fetch source IBANs
    const sourceIbans = await getSourceIbans(userId);
    console.log(`[onUserDataUpdate] Found ${sourceIbans.length} source IBANs`);

    // The candidate set is every File the user owns, paged rather than capped.
    // It used to be a `.limit()` over an unordered query with the extraction
    // and isNotInvoice filters folded in, which meant three different ways for
    // a File to be absent from the run with nothing recording that it was
    // (#158). Both filters are still applied — they are now named skip
    // reasons, so a File that is not swept says why.
    const runId = db.collection(`users/${userId}/directionSweeps`).doc().id;
    const ledger = new SweepLedger();
    const planned: PlannedFileWrite[] = [];
    // One stamp for every write of the run, so a File replayed after a
    // refused batch is written the same twice (#158).
    const runAt = Timestamp.now();

    let scanned = 0;
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;

    for (;;) {
      let query = db
        .collection("files")
        .where("userId", "==", userId)
        .orderBy("__name__")
        .limit(CONFIG.PAGE_SIZE);
      if (cursor) query = query.startAfter(cursor);

      const snapshot = await query.get();
      if (snapshot.empty) break;

      for (const fileDoc of snapshot.docs) {
        scanned++;
        ledger.candidate();
        await planFileSweep(fileDoc, userData, sourceIbans, ledger, planned, runAt);
      }

      if (snapshot.size < CONFIG.PAGE_SIZE) break;
      if (scanned >= CONFIG.MAX_FILES_SCANNED) {
        // Stop, and say so. The Files past this point are not in the candidate
        // set at all, so the run cannot claim to have covered the corpus.
        ledger.ceilingReached();
        break;
      }
      cursor = snapshot.docs[snapshot.docs.length - 1];
    }

    const affectedTransactionIds = await commitSweepWrites(
      planned,
      ledger,
      async (chunk) => {
        const batch = db.batch();
        for (const write of chunk) batch.update(write.ref, write.updates);
        await batch.commit();
      },
      CONFIG.MAX_BATCH_SIZE
    );

    // Recorded before the propagation below, not after: the books are closed
    // once the writes have had their verdicts, and a throw further down must
    // not be one more way for a run that moved Files to leave no record of it
    // (#158).
    const summary = ledger.summarise(runId, userId);
    console.log(formatSweepSummary(summary));
    await persistSweepSummary(summary);

    // A file's classification changing is invisible to onTransactionUpdate —
    // nothing on the transaction document moved — so the propagation happens
    // here, the same way the extraction path does it (#104). Only writes that
    // actually landed are propagated; a rejected one moved nothing.
    if (affectedTransactionIds.size > 0) {
      await syncDocumentationStateForTransactions(db, [...affectedTransactionIds]);
    }
  }
);

// === On User Data Created ===

/**
 * Triggered when user data document is first created.
 * Creates identity partners for all entities (personalEntity + companies).
 */
export const onUserDataCreated = onDocumentCreated(
  {
    document: "users/{userId}/settings/userData",
    region: CONFIG.REGION,
  },
  async (event) => {
    const userId = event.params.userId;
    const data = event.data?.data();

    if (!data) {
      console.log(`[onUserDataCreated] No data for user ${userId}`);
      return;
    }

    const now = Timestamp.now();
    const updates: Record<string, unknown> = {};

    // Create partner for personal entity
    const personalEntity = data.personalEntity as IdentityEntity | undefined;
    if (personalEntity?.name?.trim()) {
      const partnerId = await createIdentityPartner(userId, "personalEntity", personalEntity, now);
      updates["personalEntity.partnerId"] = partnerId;
      console.log(`[onUserDataCreated] Created personal entity partner: ${partnerId}`);
    }

    // Create partners for companies
    const companies = (data.companies || []) as IdentityEntity[];
    const updatedCompanies: IdentityEntity[] = [];
    let companiesUpdated = false;

    for (const company of companies) {
      if (company.name?.trim() && !company.partnerId) {
        const partnerId = await createIdentityPartner(
          userId,
          `company:${company.id}`,
          company,
          now
        );
        updatedCompanies.push({ ...company, partnerId });
        companiesUpdated = true;
        console.log(`[onUserDataCreated] Created company partner for ${company.id}: ${partnerId}`);
      } else {
        updatedCompanies.push(company);
      }
    }

    if (companiesUpdated) {
      updates["companies"] = updatedCompanies;
    }

    // === Legacy format support ===
    const name = data.name?.trim() || "";
    const companyName = data.companyName?.trim() || "";
    const identityPartnerIds: IdentityPartnerIds = data.identityPartnerIds || {};
    let legacyUpdated = false;

    // Create name partner if set (legacy)
    if (name && !identityPartnerIds.name) {
      const legacyEntity: IdentityEntity = {
        id: "legacy_name",
        type: "person",
        name,
        aliases: data.aliases || [],
        ibans: data.ibans || [],
        vatId: data.vatIds?.[0],
        order: 0,
        createdAt: now,
      };
      const partnerId = await createIdentityPartner(userId, "personalEntity", legacyEntity, now);
      identityPartnerIds.name = partnerId;
      legacyUpdated = true;
    }

    // Create companyName partner if set (legacy)
    if (companyName && !identityPartnerIds.companyName) {
      const legacyEntity: IdentityEntity = {
        id: "legacy_company",
        type: "company",
        name: companyName,
        aliases: [],
        ibans: [],
        vatId: data.vatIds?.[1],
        order: 0,
        createdAt: now,
      };
      const partnerId = await createIdentityPartner(userId, `company:legacy`, legacyEntity, now);
      identityPartnerIds.companyName = partnerId;
      legacyUpdated = true;
    }

    if (legacyUpdated) {
      updates["identityPartnerIds"] = identityPartnerIds;
    }

    // Apply updates
    if (Object.keys(updates).length > 0) {
      const userDataRef = db.doc(`users/${userId}/settings/userData`);
      await userDataRef.update({
        ...updates,
        updatedAt: now,
      });
      console.log(`[onUserDataCreated] Updated userData with partner IDs:`, Object.keys(updates));
    } else {
      console.log(`[onUserDataCreated] No partners to create for user ${userId}`);
    }
  }
);
