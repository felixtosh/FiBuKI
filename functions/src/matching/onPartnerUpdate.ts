/**
 * Cloud Function: On Partner Update
 *
 * Triggered when a user partner is updated.
 * Re-evaluates file matching when partner data (name, aliases, VAT, IBANs, website, emailDomains) changes.
 *
 * Only affects:
 * - Files auto-matched to this partner (re-run matching - might find better match)
 * - Unmatched files (check against the updated partner)
 *
 * Does NOT affect files manually assigned to this partner.
 *
 * Every affected file is considered, however many there are: both queries are
 * paged through rather than capped (#329). A run that fails or is cut off part
 * way has logged how far it got, so a partial re-match is never a silent one.
 */

import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import {
  matchFileToAllPartners,
  shouldAutoApply,
  PartnerData,
} from "../utils/filePartnerMatcher";
import { AutomationMeta } from "../automation/types";
import { MERGE_WRITE_ID_FIELD, isMergeWrite } from "../partners/mergeWriteMarker";
import { activityEntry, logActivity } from "../utils/activity";

// =============================================================================
// AUTOMATION METADATA
// =============================================================================

export const AUTOMATION_META: AutomationMeta = {
  id: "onPartnerUpdate",
  name: "Re-match Files on Partner Update",
  description:
    "Re-evaluates file matches when partner details (name, aliases, IBAN, VAT, website, email domains) change",
  trigger: {
    type: "document_update",
    collection: "partners",
  },
  effects: [
    {
      entity: "file",
      fields: [
        "partnerId",
        "partnerType",
        "partnerMatchedBy",
        "partnerMatchConfidence",
        "partnerSuggestions",
      ],
      action: "update",
    },
  ],
  config: {
    autoMatchThreshold: 89,
    filePageSize: 200,
  },
  icon: "FileText",
  category: "matching",
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

const db = getFirestore();

// === Configuration ===

const CONFIG = {
  /** Minimum confidence for auto-matching partner */
  AUTO_MATCH_THRESHOLD: 89,
  /** Max suggestions to store per file */
  MAX_SUGGESTIONS: 3,
  /**
   * Files read per page. Not a cap: every page is processed before the next is
   * read, so this bounds memory, not how many files an update reaches (#329).
   */
  FILE_PAGE_SIZE: 200,
};

// === Types ===

interface PartnerSuggestion {
  partnerId: string;
  partnerType: "user" | "global";
  confidence: number;
  source: "iban" | "vatId" | "name" | "emailDomain" | "website";
}

// === Helper Functions ===

/**
 * Check if partner matching-relevant fields changed
 */
function hasMatchingFieldsChanged(
  before: FirebaseFirestore.DocumentData,
  after: FirebaseFirestore.DocumentData
): boolean {
  // Name changed
  if (before.name !== after.name) return true;

  // Aliases changed
  if (JSON.stringify(before.aliases || []) !== JSON.stringify(after.aliases || [])) return true;

  // Website changed
  if (before.website !== after.website) return true;

  // VAT ID changed
  if (before.vatId !== after.vatId) return true;

  // IBANs changed
  if (JSON.stringify(before.ibans || []) !== JSON.stringify(after.ibans || [])) return true;

  // Email domains changed
  if (JSON.stringify(before.emailDomains || []) !== JSON.stringify(after.emailDomains || [])) return true;

  return false;
}

/**
 * Re-run partner matching for a file against all partners
 */
async function reMatchFilePartner(
  fileDoc: FirebaseFirestore.QueryDocumentSnapshot,
  userPartners: PartnerData[],
  globalPartners: PartnerData[]
): Promise<{ action: "rematched" | "cleared" | "unchanged"; newPartnerId: string | null }> {
  const fileData = fileDoc.data();
  const previousPartnerId = fileData.partnerId || null;

  const matches = matchFileToAllPartners(
    {
      extractedIban: fileData.extractedIban,
      extractedVatId: fileData.extractedVatId,
      extractedPartner: fileData.extractedPartner,
      extractedWebsite: fileData.extractedWebsite,
      gmailSenderDomain: fileData.gmailSenderDomain,
    },
    userPartners,
    globalPartners
  );

  // Build suggestions
  const suggestions: PartnerSuggestion[] = matches.slice(0, CONFIG.MAX_SUGGESTIONS).map((m) => ({
    partnerId: m.partnerId,
    partnerType: m.partnerType,
    confidence: m.confidence,
    source: m.source,
  }));

  const topMatch = matches[0];
  const update: Record<string, unknown> = {
    partnerMatchedAt: Timestamp.now(),
    partnerSuggestions: suggestions,
    updatedAt: Timestamp.now(),
  };

  let action: "rematched" | "cleared" | "unchanged" = "unchanged";
  let newPartnerId: string | null = previousPartnerId;

  if (topMatch && shouldAutoApply(topMatch.confidence)) {
    // Found a high-confidence match
    if (topMatch.partnerId !== previousPartnerId) {
      update.partnerId = topMatch.partnerId;
      update.partnerType = topMatch.partnerType;
      update.partnerMatchedBy = "auto";
      update.partnerMatchConfidence = topMatch.confidence;
      action = "rematched";
      newPartnerId = topMatch.partnerId;

      console.log(
        `[PartnerUpdate] Re-matched file ${fileDoc.id} to partner ${topMatch.partnerId} ` +
        `(confidence: ${topMatch.confidence}%, was: ${previousPartnerId || "none"})`
      );
    }
  } else if (previousPartnerId) {
    // Previously had a partner but no good match now - clear it
    update.partnerId = null;
    update.partnerType = null;
    update.partnerMatchedBy = null;
    update.partnerMatchConfidence = null;
    action = "cleared";
    newPartnerId = null;

    console.log(`[PartnerUpdate] Cleared partner from file ${fileDoc.id} (no confident match)`);
  }

  // The log (#752): what the re-match changed on the File.
  const nameOf = (id: string) => [...userPartners, ...globalPartners].find((p) => p.id === id)?.name ?? id;
  if (action === "rematched" && topMatch) {
    Object.assign(update, logActivity(activityEntry({
      type: "partner_assigned",
      actor: "auto",
      partnerName: nameOf(topMatch.partnerId),
      forPartnerId: topMatch.partnerId,
      confidence: topMatch.confidence,
      summary: `Partner "${nameOf(topMatch.partnerId)}" assigned after a Partner changed (${Math.round(topMatch.confidence)}%)`,
    })));
  } else if (action === "cleared" && previousPartnerId) {
    Object.assign(update, logActivity(activityEntry({
      type: "partner_removed",
      actor: "auto",
      partnerName: nameOf(previousPartnerId),
      forPartnerId: previousPartnerId,
      summary: `Partner "${nameOf(previousPartnerId)}" removed after a Partner changed: no confident match any more`,
    })));
  }

  await db.collection("files").doc(fileDoc.id).update(update);
  return { action, newPartnerId };
}

/**
 * Visit every file a query matches, one page at a time, in document id order.
 *
 * The visitor may move a file out of the query's result set (re-matching it
 * changes `partnerId`); the cursor is the last document read, so the next page
 * starts past it either way and no file is skipped or read twice.
 */
async function forEachFilePage(
  query: FirebaseFirestore.Query,
  visit: (fileDoc: FirebaseFirestore.QueryDocumentSnapshot) => Promise<void>,
  onPage: (pageSize: number) => void = () => undefined
): Promise<void> {
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  for (;;) {
    let page = query.orderBy("__name__").limit(CONFIG.FILE_PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snapshot = await page.get();
    if (snapshot.empty) return;
    for (const fileDoc of snapshot.docs) await visit(fileDoc);
    onPage(snapshot.size);
    if (snapshot.size < CONFIG.FILE_PAGE_SIZE) return;
    cursor = snapshot.docs[snapshot.docs.length - 1];
  }
}

/**
 * Every active partner the file matcher compares against: the user's own, and
 * the global ones the user has not localized. Read once per run, after the
 * first file needing it, so an update with nothing to re-evaluate reads none.
 */
async function loadMatchingPartners(
  userId: string
): Promise<{ userPartners: PartnerData[]; globalPartners: PartnerData[] }> {
  const [userPartnersSnapshot, globalPartnersSnapshot] = await Promise.all([
    db.collection("partners")
      .where("userId", "==", userId)
      .where("isActive", "==", true)
      .get(),
    db.collection("globalPartners")
      .where("isActive", "==", true)
      .get(),
  ]);

  const userPartners: PartnerData[] = userPartnersSnapshot.docs.map((doc) => ({
    id: doc.id,
    name: doc.data().name,
    aliases: doc.data().aliases || [],
    ibans: doc.data().ibans || [],
    vatId: doc.data().vatId,
    website: doc.data().website || null,
    emailDomains: doc.data().emailDomains || [],
    globalPartnerId: doc.data().globalPartnerId || null,
  }));

  const globalPartners: PartnerData[] = globalPartnersSnapshot.docs.map((doc) => ({
    id: doc.id,
    name: doc.data().name,
    aliases: doc.data().aliases || [],
    ibans: doc.data().ibans || [],
    vatId: doc.data().vatId,
    website: doc.data().website || null,
    emailDomains: doc.data().emailDomains || [],
  }));
  const localizedGlobalIds = new Set(
    userPartnersSnapshot.docs
      .map((doc) => doc.data().globalPartnerId)
      .filter(Boolean) as string[]
  );

  return {
    userPartners,
    globalPartners: globalPartners.filter((partner) => !localizedGlobalIds.has(partner.id)),
  };
}

/**
 * Unmatched files that already went through matching once — the files a
 * partner edit or deletion can newly claim.
 */
function unmatchedFilesQuery(userId: string): FirebaseFirestore.Query {
  return db
    .collection("files")
    .where("userId", "==", userId)
    .where("partnerId", "==", null)
    .where("extractionComplete", "==", true)
    .where("partnerMatchComplete", "==", true);
}

/**
 * Re-match orphaned files after a partner is deleted.
 * Finds all unmatched files for the user and re-runs partner matching.
 */
async function reMatchOrphanedFilesAfterDeletion(
  userId: string,
  deletedPartnerId: string,
  deletedPartnerName: string
): Promise<void> {
  // These are files that either:
  // 1. Were just orphaned by the deletion (partnerId was cleared by deleteUserPartner)
  // 2. Were already unmatched before
  let partners: Awaited<ReturnType<typeof loadMatchingPartners>> | null = null;
  let considered = 0;
  let reMatched = 0;
  let stillUnmatched = 0;

  try {
    await forEachFilePage(
      unmatchedFilesQuery(userId),
      async (fileDoc) => {
        // Fetch all active partners for matching (excluding the deleted one)
        partners ??= await loadMatchingPartners(userId);
        considered++;
        try {
          const { action, newPartnerId } = await reMatchFilePartner(
            fileDoc,
            partners.userPartners,
            partners.globalPartners
          );

          if (action === "rematched" && newPartnerId) {
            reMatched++;
          } else {
            stillUnmatched++;
          }
        } catch (error) {
          console.error(`[PartnerUpdate] Error re-matching orphaned file ${fileDoc.id}:`, error);
          stillUnmatched++;
        }
      },
      () => {
        console.log(
          `[PartnerUpdate] Re-matching after "${deletedPartnerName}" deletion: ` +
          `${considered} orphaned files considered so far`
        );
      }
    );

    if (considered === 0) {
      console.log(
        `[PartnerUpdate] No orphaned files to re-match after deleting "${deletedPartnerName}"`
      );
      return;
    }

    console.log(
      `[PartnerUpdate] Re-matching after "${deletedPartnerName}" deletion complete: ` +
      `all ${considered} orphaned files considered, ` +
      `${reMatched} re-matched to new partners, ${stillUnmatched} still unmatched`
    );

  } catch (error) {
    console.error(
      `[PartnerUpdate] Error re-matching files after partner ${deletedPartnerId} deletion, ` +
      `stopped after ${considered} files (${reMatched} re-matched); ` +
      "the rest were not re-evaluated:",
      error
    );
  }
}

// === Main Trigger ===

export const onPartnerUpdate = onDocumentUpdated(
  {
    document: "partners/{partnerId}",
    region: "europe-west1",
    // The most an event trigger gets: an update now reaches every affected
    // file rather than the first 200 (#329). A run cut off anyway has logged
    // its progress page by page.
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    const partnerId = event.params.partnerId;

    if (!before || !after) return;

    const userId = after.userId;

    // A Merge deliberately does not re-run the Match (#262, ADR-0005), and it
    // writes BOTH sides: the survivor gains the losers' identifying data, each
    // loser becomes a Merged Partner. Unguarded, the loser write would fire the
    // post-deletion re-match (a merged-away partner is not a deleted one — its
    // files were repointed to the survivor, not orphaned) and the survivor
    // write would fire the identity re-match over every affected file (#306,
    // #329). One marker, put on every Partner document the Merge writes,
    // answers for both.
    if (isMergeWrite(before, after)) {
      console.log(
        `[PartnerUpdate] Partner "${after.name}" (${partnerId}) was written by a ` +
        `merge (${after[MERGE_WRITE_ID_FIELD]}), skipping re-matching`
      );
      return;
    }

    // Check if partner was just deleted (soft-delete: isActive true -> false)
    const wasJustDeleted = before.isActive === true && after.isActive === false;

    if (wasJustDeleted) {
      // Partner was deleted - re-match all orphaned files for this user
      console.log(
        `[PartnerUpdate] Partner "${before.name}" (${partnerId}) was deleted, re-matching orphaned files`
      );
      await reMatchOrphanedFilesAfterDeletion(userId, partnerId, before.name);
      return;
    }

    // Skip if partner is inactive (but not just deleted)
    if (!after.isActive) {
      console.log(`[PartnerUpdate] Partner ${partnerId} is inactive, skipping file re-matching`);
      return;
    }

    // Skip if matching-relevant fields haven't changed
    if (!hasMatchingFieldsChanged(before, after)) {
      return;
    }

    console.log(
      `[PartnerUpdate] Partner "${after.name}" (${partnerId}) updated, re-evaluating files`
    );

    let partners: Awaited<ReturnType<typeof loadMatchingPartners>> | null = null;
    // A file the first pass clears joins the unmatched set the second pass
    // reads; it has been evaluated against the updated partner already.
    const considered = new Set<string>();
    let autoMatched = 0;
    let reMatched = 0;
    let cleared = 0;
    let unchanged = 0;

    const reEvaluate = async (fileDoc: FirebaseFirestore.QueryDocumentSnapshot) => {
      if (considered.has(fileDoc.id)) return;
      considered.add(fileDoc.id);
      // Fetch all partners for matching (need fresh data including the updated partner)
      partners ??= await loadMatchingPartners(userId);
      try {
        const { action } = await reMatchFilePartner(
          fileDoc,
          partners.userPartners,
          partners.globalPartners
        );

        switch (action) {
          case "rematched":
            reMatched++;
            break;
          case "cleared":
            cleared++;
            break;
          case "unchanged":
            unchanged++;
            break;
        }
      } catch (error) {
        console.error(`[PartnerUpdate] Error re-matching file ${fileDoc.id}:`, error);
      }
    };

    const logProgress = () => {
      console.log(
        `[PartnerUpdate] Partner "${after.name}" (${partnerId}): ` +
        `${considered.size} files considered so far (${autoMatched} auto-matched)`
      );
    };

    try {
      // Pass 1: Files auto-matched to this partner (need re-evaluation)
      await forEachFilePage(
        db
          .collection("files")
          .where("userId", "==", userId)
          .where("partnerId", "==", partnerId)
          .where("partnerMatchedBy", "==", "auto")
          .where("extractionComplete", "==", true),
        async (fileDoc) => {
          autoMatched++;
          await reEvaluate(fileDoc);
        },
        logProgress
      );

      // Pass 2: Unmatched files (need to check against updated partner)
      await forEachFilePage(unmatchedFilesQuery(userId), reEvaluate, logProgress);

      if (considered.size === 0) {
        console.log(`[PartnerUpdate] No files to re-evaluate for partner ${partnerId}`);
        return;
      }

      console.log(
        `[PartnerUpdate] Partner "${after.name}" update complete: ` +
        `all ${considered.size} files considered (${autoMatched} auto-matched), ` +
        `${reMatched} re-matched, ${cleared} cleared, ${unchanged} unchanged`
      );

    } catch (error) {
      console.error(
        `[PartnerUpdate] Error re-matching files for partner ${partnerId}, ` +
        `stopped after ${considered.size} files (${reMatched} re-matched, ${cleared} cleared); ` +
        "the rest were not re-evaluated:",
        error
      );
    }
  }
);
