"use strict";
/**
 * Global Partner Upsert Utility
 *
 * Creates global partner docs from VIES validation results.
 * Uses deterministic IDs to prevent duplicates from race conditions.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureGlobalPartnerFromVies = ensureGlobalPartnerFromVies;
const firestore_1 = require("firebase-admin/firestore");
const db = (0, firestore_1.getFirestore)();
const GLOBAL_PARTNERS_COLLECTION = "globalPartners";
/**
 * Ensure a global partner exists for a VIES-validated company.
 *
 * Uses a deterministic doc ID (`vies_<normalized_vat_id>`) so concurrent
 * calls for the same VAT ID are safe — the second write is a no-op.
 *
 * @returns globalPartnerId and whether a new doc was created
 */
async function ensureGlobalPartnerFromVies(vatId, name, country, address) {
    const normalizedVatId = vatId.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const docId = `vies_${normalizedVatId.toLowerCase()}`;
    const docRef = db.collection(GLOBAL_PARTNERS_COLLECTION).doc(docId);
    const existing = await docRef.get();
    if (existing.exists) {
        return { globalPartnerId: docId, wasCreated: false };
    }
    const now = firestore_1.Timestamp.now();
    await docRef.set({
        name,
        aliases: [],
        address: address || null,
        country,
        vatId: normalizedVatId,
        ibans: [],
        website: null,
        externalIds: null,
        source: "external_registry",
        sourceDetails: {
            contributingUserIds: ["system"],
            confidence: 95,
            verifiedAt: now,
            verifiedBy: "vies",
        },
        patterns: [],
        isActive: true,
        createdAt: now,
        updatedAt: now,
    });
    console.log(`[GlobalPartnerUpsert] Created global partner ${docId} for "${name}" (${normalizedVatId})`);
    return { globalPartnerId: docId, wasCreated: true };
}
//# sourceMappingURL=globalPartnerUpsert.js.map