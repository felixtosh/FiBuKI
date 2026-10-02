import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { isAdminCaller } from "../utils/adminCaller";
import {
  normalizeIban,
  normalizeCompanyName,
  calculateCompanyNameSimilarity,
} from "../utils/partner-matcher";

const FIREBASE_PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "taxstudio-f12fb";
const CORS_ORIGINS = [
  process.env.APP_URL || "https://fibuki.com",
  `https://${FIREBASE_PROJECT_ID}.firebaseapp.com`,
  `https://${FIREBASE_PROJECT_ID}.web.app`,
  "http://localhost:3000",
];

const db = getFirestore();

/**
 * Recursively remove undefined values from an object (Firestore doesn't accept undefined)
 */
function stripUndefined<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => stripUndefined(item)) as T;
  }

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (value !== undefined) {
        result[key] = stripUndefined(value);
      }
    }
    return result as T;
  }

  return obj;
}

interface UserPartnerData {
  id: string;
  userId: string;
  name: string;
  normalizedName: string;
  aliases: string[];
  ibans: string[];
  normalizedIbans: string[];
  vatId?: string;
  website?: string;
}

interface PartnerGroup {
  key: string;
  partners: UserPartnerData[];
  userIds: Set<string>;
  matchType: "iban" | "vatId" | "name";
}

/**
 * Callable function to generate promotion candidates
 * Analyzes user partners across all users and identifies similar partners
 * that could be promoted to the global database
 */
export const generatePromotionCandidates = onCall(
  {
    region: "europe-west1",
    cors: CORS_ORIGINS,
  },
  async (request) => {
    // Admin-only: it reads every user's Partners and promotes some into the
    // Global Partners every user can read. It had no check at all, so any
    // caller (signed in or not) could run it.
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }
    if (!isAdminCaller(request.auth)) {
      throw new HttpsError("permission-denied", "Admin access required");
    }

    console.log("Starting promotion candidates generation...");

    try {
      console.log("Starting generatePromotionCandidates...");

      // 1. Get all active user partners
      console.log("Querying partners collection...");
      const partnersSnapshot = await db
        .collection("partners")
        .where("isActive", "==", true)
        .get();

      console.log(`Query returned ${partnersSnapshot.size} documents`);

      if (partnersSnapshot.empty) {
        console.log("No active user partners found");
        return { candidatesCreated: 0, message: "No active user partners found" };
      }

      console.log(`Found ${partnersSnapshot.size} active user partners`);

      // 2. Map partners to normalized data
      // Exclude partners that were derived from global partners (they have globalPartnerId set)
      const partners: UserPartnerData[] = partnersSnapshot.docs
        .filter((doc) => !doc.data().globalPartnerId)
        .map((doc) => {
          const data = doc.data();
          return {
            id: doc.id,
            userId: data.userId,
            name: data.name,
            normalizedName: normalizeCompanyName(data.name),
            aliases: data.aliases || [],
            ibans: data.ibans || [],
            normalizedIbans: (data.ibans || []).map((iban: string) => normalizeIban(iban)),
            vatId: data.vatId,
            website: data.website,
          };
        });

      // 3. Group partners by similarity
      const groups: PartnerGroup[] = [];

      // Group by IBAN (exact match = 100% confidence)
      const ibanGroups = new Map<string, UserPartnerData[]>();
      for (const partner of partners) {
        for (const iban of partner.normalizedIbans) {
          if (iban) {
            const existing = ibanGroups.get(iban) || [];
            existing.push(partner);
            ibanGroups.set(iban, existing);
          }
        }
      }

      for (const [iban, partnerList] of ibanGroups) {
        const uniqueUsers = new Set(partnerList.map((p) => p.userId));
        if (uniqueUsers.size >= 2) {
          groups.push({
            key: `iban:${iban}`,
            partners: partnerList,
            userIds: uniqueUsers,
            matchType: "iban",
          });
        }
      }

      // Group by VAT ID (exact match = 95% confidence)
      const vatGroups = new Map<string, UserPartnerData[]>();
      for (const partner of partners) {
        if (partner.vatId) {
          const normalizedVat = partner.vatId.replace(/\s+/g, "").toUpperCase();
          const existing = vatGroups.get(normalizedVat) || [];
          existing.push(partner);
          vatGroups.set(normalizedVat, existing);
        }
      }

      for (const [vatId, partnerList] of vatGroups) {
        const uniqueUsers = new Set(partnerList.map((p) => p.userId));
        // Only create group if not already captured by IBAN
        const alreadyGrouped = groups.some((g) =>
          g.partners.some((p) => partnerList.some((pl) => pl.id === p.id))
        );
        if (uniqueUsers.size >= 2 && !alreadyGrouped) {
          groups.push({
            key: `vat:${vatId}`,
            partners: partnerList,
            userIds: uniqueUsers,
            matchType: "vatId",
          });
        }
      }

      // Group by similar name (≥80% similarity = 70-90% confidence)
      const processedPairs = new Set<string>();
      for (let i = 0; i < partners.length; i++) {
        for (let j = i + 1; j < partners.length; j++) {
          const p1 = partners[i];
          const p2 = partners[j];

          // Skip if same user
          if (p1.userId === p2.userId) continue;

          // Skip if already in an IBAN or VAT group together
          const alreadyGrouped = groups.some(
            (g) =>
              g.partners.some((p) => p.id === p1.id) &&
              g.partners.some((p) => p.id === p2.id)
          );
          if (alreadyGrouped) continue;

          const pairKey = [p1.id, p2.id].sort().join("-");
          if (processedPairs.has(pairKey)) continue;
          processedPairs.add(pairKey);

          const similarity = calculateCompanyNameSimilarity(p1.name, p2.name);
          if (similarity >= 80) {
            // Find or create a name-based group
            const existingGroup = groups.find(
              (g) =>
                g.matchType === "name" &&
                (g.partners.some((p) => p.id === p1.id) ||
                  g.partners.some((p) => p.id === p2.id))
            );

            if (existingGroup) {
              if (!existingGroup.partners.some((p) => p.id === p1.id)) {
                existingGroup.partners.push(p1);
                existingGroup.userIds.add(p1.userId);
              }
              if (!existingGroup.partners.some((p) => p.id === p2.id)) {
                existingGroup.partners.push(p2);
                existingGroup.userIds.add(p2.userId);
              }
            } else {
              groups.push({
                key: `name:${p1.normalizedName}`,
                partners: [p1, p2],
                userIds: new Set([p1.userId, p2.userId]),
                matchType: "name",
              });
            }
          }
        }
      }

      console.log(`Found ${groups.length} potential promotion groups`);

      // 4. Clear existing pending candidates
      const existingCandidates = await db
        .collection("promotionCandidates")
        .where("status", "==", "pending")
        .get();

      const batch = db.batch();
      for (const doc of existingCandidates.docs) {
        batch.delete(doc.ref);
      }

      // 5. Create new candidates from groups
      let candidatesCreated = 0;
      const addedPartnerIds = new Set<string>();

      for (const group of groups) {
        if (group.userIds.size < 2) continue;

        // Calculate confidence based on match type and user count
        let baseConfidence: number;
        switch (group.matchType) {
          case "iban":
            baseConfidence = 100;
            break;
          case "vatId":
            baseConfidence = 95;
            break;
          case "name":
            baseConfidence = 75;
            break;
          default:
            baseConfidence = 60;
        }

        // Boost confidence for more users (cap at 100)
        const userBoost = Math.min(10, (group.userIds.size - 2) * 5);
        const confidence = Math.min(100, baseConfidence + userBoost);

        // Pick the representative partner (most complete data)
        const representative = group.partners.reduce((best, current) => {
          const bestScore =
            (best.ibans.length > 0 ? 2 : 0) +
            (best.vatId ? 2 : 0) +
            (best.website ? 1 : 0) +
            best.aliases.length;
          const currentScore =
            (current.ibans.length > 0 ? 2 : 0) +
            (current.vatId ? 2 : 0) +
            (current.website ? 1 : 0) +
            current.aliases.length;
          return currentScore > bestScore ? current : best;
        });

        // Get the full partner document
        const partnerDoc = await db.collection("partners").doc(representative.id).get();
        const partnerData = partnerDoc.data();

        if (!partnerData) continue;

        const candidateId = `candidate_${group.key.replace(/[^a-zA-Z0-9]/g, "_")}`;
        batch.set(db.collection("promotionCandidates").doc(candidateId), stripUndefined({
          userPartner: {
            id: representative.id,
            userId: representative.userId,
            name: partnerData.name,
            aliases: partnerData.aliases || [],
            address: partnerData.address,
            vatId: partnerData.vatId,
            viesVerified: partnerData.viesVerified || false,
            viesVerifiedAt: partnerData.viesVerifiedAt || null,
            ibans: partnerData.ibans || [],
            website: partnerData.website,
            notes: partnerData.notes,
            isActive: partnerData.isActive,
            createdAt: partnerData.createdAt,
            updatedAt: partnerData.updatedAt,
          },
          userCount: group.userIds.size,
          confidence,
          status: "pending",
          matchType: group.matchType,
          contributingUserIds: Array.from(group.userIds),
          createdAt: FieldValue.serverTimestamp(),
        }));

        // Track added partners
        group.partners.forEach((p) => addedPartnerIds.add(p.id));
        candidatesCreated++;
      }

      // 6. Add remaining single-user partners (not in any group)
      // These are candidates for manual review/promotion
      for (const partner of partners) {
        if (addedPartnerIds.has(partner.id)) continue;

        const partnerDoc = await db.collection("partners").doc(partner.id).get();
        const partnerData = partnerDoc.data();
        if (!partnerData) continue;

        // Calculate confidence based on data completeness
        let dataScore = 0;
        if (partner.ibans.length > 0) dataScore += 30;
        if (partner.vatId) dataScore += 25;
        if (partner.website) dataScore += 15;
        if (partner.aliases.length > 0) dataScore += 10;

        // Base confidence of 50 for single-user, plus data completeness bonus
        const confidence = Math.min(80, 50 + Math.round(dataScore / 4));

        const candidateId = `single_${partner.id}`;
        batch.set(db.collection("promotionCandidates").doc(candidateId), stripUndefined({
          userPartner: {
            id: partner.id,
            userId: partner.userId,
            name: partnerData.name,
            aliases: partnerData.aliases || [],
            address: partnerData.address,
            vatId: partnerData.vatId,
            viesVerified: partnerData.viesVerified || false,
            viesVerifiedAt: partnerData.viesVerifiedAt || null,
            ibans: partnerData.ibans || [],
            website: partnerData.website,
            notes: partnerData.notes,
            isActive: partnerData.isActive,
            createdAt: partnerData.createdAt,
            updatedAt: partnerData.updatedAt,
          },
          userCount: 1,
          confidence,
          status: "pending",
          matchType: "single",
          contributingUserIds: [partner.userId],
          createdAt: FieldValue.serverTimestamp(),
        }));

        addedPartnerIds.add(partner.id);
        candidatesCreated++;
      }

      // 7. Auto-approve VIES-verified candidates
      // Query all existing global partners with VAT IDs for merge lookup
      const globalPartnersSnapshot = await db
        .collection("globalPartners")
        .where("isActive", "==", true)
        .get();

      const globalPartnersByVat = new Map<string, { id: string; data: FirebaseFirestore.DocumentData }>();
      for (const doc of globalPartnersSnapshot.docs) {
        const data = doc.data();
        if (data.vatId) {
          const normalizedVat = data.vatId.replace(/\s+/g, "").toUpperCase();
          globalPartnersByVat.set(normalizedVat, { id: doc.id, data });
        }
      }

      // Commit candidates batch, then post-process VIES-verified ones
      await batch.commit();

      // Now scan pending candidates and auto-approve VIES-verified ones
      const pendingCandidates = await db
        .collection("promotionCandidates")
        .where("status", "==", "pending")
        .get();

      let autoApproved = 0;
      const autoApproveBatch = db.batch();

      for (const candidateDoc of pendingCandidates.docs) {
        const candidate = candidateDoc.data();
        const up = candidate.userPartner;

        if (!up?.viesVerified || !up?.vatId) continue;

        const normalizedVat = up.vatId.replace(/\s+/g, "").toUpperCase();
        const existingGlobal = globalPartnersByVat.get(normalizedVat);

        // The id of the global we end up linked to (existing or newly created).
        // Used below to backlink the originating user partner so the picker
        // doesn't show both copies side by side.
        let linkedGlobalId: string;

        if (existingGlobal) {
          // Merge into existing global partner
          const gData = existingGlobal.data;
          const updates: Record<string, unknown> = {
            updatedAt: FieldValue.serverTimestamp(),
          };

          // Add new IBANs not already present
          if (up.ibans?.length) {
            const existingNormalized = (gData.ibans || []).map((i: string) => normalizeIban(i));
            const newIbans = up.ibans.filter(
              (iban: string) => !existingNormalized.includes(normalizeIban(iban))
            );
            if (newIbans.length > 0) {
              updates.ibans = [...(gData.ibans || []), ...newIbans];
            }
          }

          // Add candidate name + aliases as new aliases (if not already present)
          const existingAliases = (gData.aliases || []).map((a: string) => a.toLowerCase());
          const candidateNames = [up.name, ...(up.aliases || [])].filter(Boolean);
          const newAliases = candidateNames.filter(
            (n: string) =>
              n.toLowerCase() !== (gData.name || "").toLowerCase() &&
              !existingAliases.includes(n.toLowerCase())
          );
          if (newAliases.length > 0) {
            updates.aliases = [...(gData.aliases || []), ...newAliases];
          }

          // Fill in missing fields (don't overwrite existing)
          if (!gData.website && up.website) {
            updates.website = up.website;
          }
          if (!gData.address && up.address) {
            updates.address = up.address;
          }
          if (!gData.country && up.address?.country) {
            updates.country = up.address.country;
          }

          autoApproveBatch.update(
            db.collection("globalPartners").doc(existingGlobal.id),
            updates
          );
          linkedGlobalId = existingGlobal.id;
        } else {
          // Create new global partner
          const newDocId = `vies_${normalizedVat.toLowerCase()}`;
          const now = Timestamp.now();
          autoApproveBatch.set(
            db.collection("globalPartners").doc(newDocId),
            stripUndefined({
              name: up.name,
              aliases: up.aliases || [],
              address: up.address || null,
              country: up.address?.country || normalizedVat.slice(0, 2),
              vatId: normalizedVat,
              ibans: up.ibans || [],
              website: up.website || null,
              externalIds: null,
              source: "user_promoted",
              sourceDetails: {
                contributingUserIds: candidate.contributingUserIds || [],
                confidence: candidate.confidence || 95,
                verifiedAt: now,
                verifiedBy: "vies",
              },
              patterns: [],
              isActive: true,
              createdAt: now,
              updatedAt: now,
            })
          );
          linkedGlobalId = newDocId;
        }

        // Backlink the originating user partner to the global it was promoted
        // into. Without this, the user keeps seeing both their local copy and
        // the new global in pickers (was the root cause of the PHH duplicate
        // reported in the field).
        if (up.id) {
          autoApproveBatch.update(
            db.collection("partners").doc(up.id),
            {
              globalPartnerId: linkedGlobalId,
              updatedAt: FieldValue.serverTimestamp(),
            }
          );
        }

        // Mark candidate as auto-approved
        autoApproveBatch.update(candidateDoc.ref, { status: "auto_approved" });
        autoApproved++;
      }

      if (autoApproved > 0) {
        await autoApproveBatch.commit();
      }

      const pendingCount = candidatesCreated - autoApproved;
      console.log(
        `Created ${candidatesCreated} candidates: ${autoApproved} auto-approved, ${pendingCount} pending review`
      );

      return {
        candidatesCreated,
        autoApproved,
        groupsAnalyzed: groups.length,
        partnersAnalyzed: partners.length,
        message: `Created ${candidatesCreated} candidates: ${autoApproved} auto-approved (VIES-verified), ${pendingCount} pending review`,
      };
    } catch (error) {
      console.error("Error generating promotion candidates:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Error details:", errorMessage);
      throw new HttpsError("internal", `Failed to generate promotion candidates: ${errorMessage}`);
    }
  }
);
