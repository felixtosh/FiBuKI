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
 */

import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import {
  matchFileToAllPartners,
  shouldAutoApply,
  PartnerData,
} from "../utils/filePartnerMatcher";
import { AutomationMeta } from "../automation/types";

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
    maxFilesPerUpdate: 200,
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
  /** Maximum files to process per update */
  MAX_FILES_PER_UPDATE: 200,
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

  await db.collection("files").doc(fileDoc.id).update(update);
  return { action, newPartnerId };
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
  try {
    // Query unmatched files that have extraction complete
    // These are files that either:
    // 1. Were just orphaned by the deletion (partnerId was cleared by deleteUserPartner)
    // 2. Were already unmatched before
    const unmatchedFilesSnapshot = await db
      .collection("files")
      .where("userId", "==", userId)
      .where("partnerId", "==", null)
      .where("extractionComplete", "==", true)
      .where("partnerMatchComplete", "==", true)
      .limit(CONFIG.MAX_FILES_PER_UPDATE)
      .get();

    if (unmatchedFilesSnapshot.empty) {
      console.log(
        `[PartnerUpdate] No orphaned files to re-match after deleting "${deletedPartnerName}"`
      );
      return;
    }

    console.log(
      `[PartnerUpdate] Found ${unmatchedFilesSnapshot.size} orphaned files to re-match ` +
      `after deleting partner "${deletedPartnerName}" (${deletedPartnerId})`
    );

    // Fetch all active partners for matching (excluding the deleted one)
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
    const filteredGlobalPartners = globalPartners.filter(
      (partner) => !localizedGlobalIds.has(partner.id)
    );

    // Process files
    let reMatched = 0;
    let stillUnmatched = 0;

    for (const fileDoc of unmatchedFilesSnapshot.docs) {
      try {
        const { action, newPartnerId } = await reMatchFilePartner(
          fileDoc,
          userPartners,
          filteredGlobalPartners
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
    }

    console.log(
      `[PartnerUpdate] Re-matching after "${deletedPartnerName}" deletion complete: ` +
      `${reMatched} re-matched to new partners, ${stillUnmatched} still unmatched`
    );

  } catch (error) {
    console.error(
      `[PartnerUpdate] Error re-matching files after partner ${deletedPartnerId} deletion:`,
      error
    );
  }
}

// === Main Trigger ===

export const onPartnerUpdate = onDocumentUpdated(
  {
    document: "partners/{partnerId}",
    region: "europe-west1",
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    const partnerId = event.params.partnerId;

    if (!before || !after) return;

    const userId = after.userId;

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

    try {
      // Query 1: Files auto-matched to this partner (need re-evaluation)
      const autoMatchedFilesSnapshot = await db
        .collection("files")
        .where("userId", "==", userId)
        .where("partnerId", "==", partnerId)
        .where("partnerMatchedBy", "==", "auto")
        .where("extractionComplete", "==", true)
        .limit(CONFIG.MAX_FILES_PER_UPDATE)
        .get();

      // Query 2: Unmatched files (need to check against updated partner)
      const unmatchedFilesSnapshot = await db
        .collection("files")
        .where("userId", "==", userId)
        .where("partnerId", "==", null)
        .where("extractionComplete", "==", true)
        .where("partnerMatchComplete", "==", true) // Already went through matching once
        .limit(CONFIG.MAX_FILES_PER_UPDATE)
        .get();

      const filesToProcess = [
        ...autoMatchedFilesSnapshot.docs,
        ...unmatchedFilesSnapshot.docs,
      ];

      if (filesToProcess.length === 0) {
        console.log(`[PartnerUpdate] No files to re-evaluate for partner ${partnerId}`);
        return;
      }

      console.log(
        `[PartnerUpdate] Found ${autoMatchedFilesSnapshot.size} auto-matched + ` +
        `${unmatchedFilesSnapshot.size} unmatched = ${filesToProcess.length} files to process`
      );

      // Fetch all partners for matching (need fresh data including the updated partner)
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
      const filteredGlobalPartners = globalPartners.filter(
        (partner) => !localizedGlobalIds.has(partner.id)
      );

      // Process files
      let reMatched = 0;
      let cleared = 0;
      let unchanged = 0;

      for (const fileDoc of filesToProcess) {
        try {
          const { action } = await reMatchFilePartner(fileDoc, userPartners, filteredGlobalPartners);

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
      }

      console.log(
        `[PartnerUpdate] Partner "${after.name}" update complete: ` +
        `${reMatched} re-matched, ${cleared} cleared, ${unchanged} unchanged`
      );

    } catch (error) {
      console.error(`[PartnerUpdate] Error re-matching files for partner ${partnerId}:`, error);
    }
  }
);
