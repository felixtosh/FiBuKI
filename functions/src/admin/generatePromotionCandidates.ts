import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
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
  async () => {
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

      await batch.commit();

      console.log(`Created ${candidatesCreated} promotion candidates (including single-user)`);

      return {
        candidatesCreated,
        groupsAnalyzed: groups.length,
        partnersAnalyzed: partners.length,
        message: `Successfully created ${candidatesCreated} promotion candidates`,
      };
    } catch (error) {
      console.error("Error generating promotion candidates:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Error details:", errorMessage);
      throw new HttpsError("internal", `Failed to generate promotion candidates: ${errorMessage}`);
    }
  }
);
