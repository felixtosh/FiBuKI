"use strict";
/**
 * Update a user partner
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateUserPartnerCallable = void 0;
const firestore_1 = require("firebase-admin/firestore");
const createCallable_1 = require("../utils/createCallable");
const LEGAL_SUFFIX_ONLY_ALIASES = new Set([
    "llc",
    "inc",
    "incorporated",
    "corp",
    "corporation",
    "ltd",
    "limited",
    "gmbh",
    "ag",
    "kg",
    "ohg",
    "og",
    "mbh",
    "co",
    "sarl",
    "sas",
    "srl",
    "spa",
    "sl",
    "bv",
    "nv",
]);
function normalizeAliasInput(alias) {
    return alias.replace(/\*/g, " ").replace(/\s+/g, " ").trim();
}
function isMeaningfulAlias(alias) {
    const normalized = alias
        .toLowerCase()
        .replace(/[^a-z0-9äöüß\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!normalized || normalized.length < 3)
        return false;
    if (LEGAL_SUFFIX_ONLY_ALIASES.has(normalized))
        return false;
    return /[a-z0-9]/i.test(normalized);
}
function sanitizeAliases(rawAliases = []) {
    const seen = new Set();
    const result = [];
    for (const rawAlias of rawAliases) {
        const cleaned = normalizeAliasInput(rawAlias);
        if (!cleaned || !isMeaningfulAlias(cleaned))
            continue;
        const dedupeKey = cleaned.toLowerCase();
        if (seen.has(dedupeKey))
            continue;
        seen.add(dedupeKey);
        result.push(cleaned);
    }
    return result;
}
function normalizeIban(iban) {
    return iban.replace(/\s/g, "").toUpperCase();
}
function normalizeUrl(url) {
    let normalized = url.trim().toLowerCase();
    if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
        normalized = "https://" + normalized;
    }
    return normalized.replace(/\/+$/, "");
}
exports.updateUserPartnerCallable = (0, createCallable_1.createCallable)({ name: "updateUserPartner" }, async (ctx, request) => {
    const { partnerId, data } = request;
    if (!partnerId) {
        throw new createCallable_1.HttpsError("invalid-argument", "partnerId is required");
    }
    // Verify ownership
    const partnerRef = ctx.db.collection("partners").doc(partnerId);
    const partnerSnap = await partnerRef.get();
    if (!partnerSnap.exists) {
        throw new createCallable_1.HttpsError("not-found", "Partner not found");
    }
    if (partnerSnap.data().userId !== ctx.userId) {
        throw new createCallable_1.HttpsError("permission-denied", "Access denied");
    }
    // Build update object
    const updates = {
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
    };
    if (data.name !== undefined) {
        updates.name = data.name.trim();
    }
    if (data.aliases !== undefined) {
        updates.aliases = sanitizeAliases(data.aliases);
    }
    if (data.address !== undefined) {
        updates.address = data.address;
    }
    if (data.country !== undefined) {
        updates.country = data.country;
    }
    if (data.vatId !== undefined) {
        updates.vatId = data.vatId?.toUpperCase().replace(/\s/g, "") || null;
    }
    if (data.ibans !== undefined) {
        updates.ibans = data.ibans.map(normalizeIban).filter(Boolean);
    }
    if (data.website !== undefined) {
        updates.website = data.website ? normalizeUrl(data.website) : null;
    }
    if (data.notes !== undefined) {
        updates.notes = data.notes;
    }
    if (data.defaultCategoryId !== undefined) {
        updates.defaultCategoryId = data.defaultCategoryId;
    }
    if (data.isMyCompany !== undefined) {
        updates.isMyCompany = data.isMyCompany;
    }
    await partnerRef.update(updates);
    console.log(`[updateUserPartner] Updated partner ${partnerId}`, {
        userId: ctx.userId,
        fields: Object.keys(updates),
    });
    return { success: true };
});
//# sourceMappingURL=updateUserPartner.js.map