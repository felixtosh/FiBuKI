"use strict";
/**
 * Create a new user partner
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createUserPartnerCallable = void 0;
const firestore_1 = require("firebase-admin/firestore");
const createCallable_1 = require("../utils/createCallable");
/**
 * Normalize IBAN by removing spaces and converting to uppercase
 */
function normalizeIban(iban) {
    return iban.replace(/\s/g, "").toUpperCase();
}
/**
 * Normalize URL by ensuring protocol and lowercasing
 */
function normalizeUrl(url) {
    let normalized = url.trim().toLowerCase();
    if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
        normalized = "https://" + normalized;
    }
    // Remove trailing slash
    return normalized.replace(/\/+$/, "");
}
exports.createUserPartnerCallable = (0, createCallable_1.createCallable)({ name: "createUserPartner" }, async (ctx, request) => {
    const { data, skipAutoMatch } = request;
    if (!data?.name?.trim()) {
        throw new createCallable_1.HttpsError("invalid-argument", "Partner name is required");
    }
    const now = firestore_1.Timestamp.now();
    const newPartner = {
        userId: ctx.userId,
        name: data.name.trim(),
        aliases: (data.aliases || []).map((a) => a.trim()).filter(Boolean),
        address: data.address || null,
        country: data.country || null,
        vatId: data.vatId?.toUpperCase().replace(/\s/g, "") || null,
        ibans: (data.ibans || []).map(normalizeIban).filter(Boolean),
        website: data.website ? normalizeUrl(data.website) : null,
        notes: data.notes || null,
        defaultCategoryId: data.defaultCategoryId || null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
    };
    // Link to global partner if creating from a global suggestion
    if (data.globalPartnerId) {
        newPartner.globalPartnerId = data.globalPartnerId;
    }
    // Mark as "my company" if specified
    if (data.isMyCompany) {
        newPartner.isMyCompany = true;
    }
    // Skip automatic matching if requested (used for manual assignment flow)
    // This prevents race condition where onPartnerCreate auto-matches before manual assignment
    if (skipAutoMatch) {
        newPartner.createdBy = "manual_assignment";
    }
    const docRef = await ctx.db.collection("partners").add(newPartner);
    console.log(`[createUserPartner] Created partner ${docRef.id}`, {
        userId: ctx.userId,
        name: data.name,
    });
    return {
        success: true,
        partnerId: docRef.id,
    };
});
//# sourceMappingURL=createUserPartner.js.map