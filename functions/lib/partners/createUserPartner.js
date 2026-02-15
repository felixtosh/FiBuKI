"use strict";
/**
 * Create a new user partner
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createUserPartnerCallable = void 0;
exports.createUserPartnerInternal = createUserPartnerInternal;
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
/**
 * Internal implementation for creating a user partner.
 * Can be called directly from MCP handlers.
 */
async function createUserPartnerInternal(dbRef, userId, data, options) {
    if (!data?.name?.trim()) {
        throw new createCallable_1.HttpsError("invalid-argument", "Partner name is required");
    }
    const now = firestore_1.Timestamp.now();
    const newPartner = {
        userId,
        name: data.name.trim(),
        aliases: sanitizeAliases(data.aliases || []),
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
    if (data.globalPartnerId) {
        newPartner.globalPartnerId = data.globalPartnerId;
    }
    if (data.isMyCompany) {
        newPartner.isMyCompany = true;
    }
    if (options?.skipAutoMatch) {
        newPartner.createdBy = "manual_assignment";
    }
    const docRef = await dbRef.collection("partners").add(newPartner);
    console.log(`[createUserPartner] Created partner ${docRef.id}`, {
        userId,
        name: data.name,
    });
    return {
        success: true,
        partnerId: docRef.id,
    };
}
exports.createUserPartnerCallable = (0, createCallable_1.createCallable)({ name: "createUserPartner" }, async (ctx, request) => {
    return createUserPartnerInternal(ctx.db, ctx.userId, request.data, {
        skipAutoMatch: request.skipAutoMatch,
    });
});
//# sourceMappingURL=createUserPartner.js.map