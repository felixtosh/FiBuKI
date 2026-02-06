"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLocalPartnerFromGlobal = createLocalPartnerFromGlobal;
const firestore_1 = require("firebase-admin/firestore");
const db = (0, firestore_1.getFirestore)();
/**
 * Create a local user partner copy from a global partner.
 */
async function createLocalPartnerFromGlobal(userId, globalPartnerId) {
    const existingSnapshot = await db
        .collection("partners")
        .where("userId", "==", userId)
        .where("globalPartnerId", "==", globalPartnerId)
        .where("isActive", "==", true)
        .limit(1)
        .get();
    if (!existingSnapshot.empty) {
        const existingId = existingSnapshot.docs[0].id;
        await replaceGlobalPartnerReferences(userId, globalPartnerId, existingId);
        return existingId;
    }
    const globalDoc = await db.collection("globalPartners").doc(globalPartnerId).get();
    if (!globalDoc.exists) {
        throw new Error(`Global partner ${globalPartnerId} not found`);
    }
    const globalData = globalDoc.data();
    const partnerData = {
        userId,
        name: globalData.name,
        aliases: globalData.aliases || [],
        website: globalData.website || null,
        vatId: globalData.vatId || null,
        country: globalData.country || null,
        ibans: globalData.ibans || [],
        address: globalData.address || null,
        isActive: true,
        globalPartnerId: globalPartnerId, // Link to global
        createdAt: firestore_1.Timestamp.now(),
        updatedAt: firestore_1.Timestamp.now(),
        createdBy: "auto_partner_match",
    };
    // Copy behavioral insights from global partner as starting values
    const insights = globalData.behavioralInsights;
    if (insights) {
        // Copy billing cycle hint
        if (insights.billingFrequency || insights.typicalInvoiceDelay != null) {
            const freqDaysMap = {
                monthly: 30,
                quarterly: 90,
                yearly: 365,
                irregular: 0,
            };
            const freqDays = insights.billingFrequency
                ? freqDaysMap[insights.billingFrequency] || 0
                : 0;
            if (freqDays > 0) {
                partnerData.billingCycle = {
                    frequencyDays: freqDays,
                    frequencyConfidence: Math.min(50, insights.contributingUsers * 10), // Low initial confidence
                    invoiceToTransactionDelay: insights.typicalInvoiceDelay ?? undefined,
                    sampleSize: 0, // No local data yet
                    updatedAt: firestore_1.Timestamp.now(),
                };
            }
        }
        // Copy scoring weights
        if (insights.defaultScoringWeights) {
            partnerData.scoringWeights = {
                ...insights.defaultScoringWeights,
                sampleSize: 0, // No local data yet
                updatedAt: firestore_1.Timestamp.now(),
            };
        }
        // Copy email domains
        if (insights.commonEmailDomains?.length > 0) {
            partnerData.emailDomains = insights.commonEmailDomains;
            partnerData.emailDomainsUpdatedAt = firestore_1.Timestamp.now();
        }
        // Copy resolution preference hint
        if (insights.typicalResolution && insights.typicalResolution !== "mixed") {
            partnerData.resolutionPreference = {
                type: insights.typicalResolution,
                confidence: Math.min(40, insights.contributingUsers * 8), // Low initial confidence
                stats: { fileCount: 0, noReceiptCount: 0, updatedAt: firestore_1.Timestamp.now() },
            };
        }
        console.log(`[PartnerMatch] Copied behavioral insights from global ${globalPartnerId}: ` +
            `freq=${insights.billingFrequency || "N/A"}, res=${insights.typicalResolution || "N/A"}, ` +
            `domains=${insights.commonEmailDomains?.length || 0}`);
    }
    const docRef = await db.collection("partners").add(partnerData);
    console.log(`[PartnerMatch] Created local partner ${docRef.id} from global ${globalPartnerId}`);
    await replaceGlobalPartnerReferences(userId, globalPartnerId, docRef.id);
    return docRef.id;
}
async function replaceGlobalPartnerReferences(userId, globalPartnerId, localPartnerId) {
    const collections = ["transactions", "files"];
    for (const collectionName of collections) {
        const snapshot = await db
            .collection(collectionName)
            .where("userId", "==", userId)
            .where("partnerId", "==", globalPartnerId)
            .where("partnerType", "==", "global")
            .get();
        if (snapshot.empty)
            continue;
        let batch = db.batch();
        let batchCount = 0;
        for (const docSnap of snapshot.docs) {
            batch.update(docSnap.ref, {
                partnerId: localPartnerId,
                partnerType: "user",
                updatedAt: firestore_1.Timestamp.now(),
            });
            batchCount++;
            if (batchCount >= 500) {
                await batch.commit();
                batch = db.batch();
                batchCount = 0;
            }
        }
        if (batchCount > 0) {
            await batch.commit();
        }
    }
}
//# sourceMappingURL=createLocalPartnerFromGlobal.js.map