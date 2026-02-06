"use strict";
/**
 * Save a browser recipe to a UserPartner.
 * Called after learn mode completes — upserts by domain (one recipe per domain per partner).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveBrowserRecipeCallable = void 0;
const createCallable_1 = require("../utils/createCallable");
const firestore_1 = require("firebase-admin/firestore");
exports.saveBrowserRecipeCallable = (0, createCallable_1.createCallable)({ name: "saveBrowserRecipe" }, async (ctx, request) => {
    const { partnerId, startUrl, domain, recordedActions, requiresAuth, originTransactionId, label, } = request;
    if (!partnerId) {
        throw new createCallable_1.HttpsError("invalid-argument", "partnerId is required");
    }
    if (!startUrl) {
        throw new createCallable_1.HttpsError("invalid-argument", "startUrl is required");
    }
    if (!domain) {
        throw new createCallable_1.HttpsError("invalid-argument", "domain is required");
    }
    if (!recordedActions || recordedActions.length === 0) {
        throw new createCallable_1.HttpsError("invalid-argument", "recordedActions must not be empty");
    }
    // Verify partner belongs to user
    const partnerRef = ctx.db.collection("partners").doc(partnerId);
    const partnerDoc = await partnerRef.get();
    if (!partnerDoc.exists) {
        throw new createCallable_1.HttpsError("not-found", "Partner not found");
    }
    if (partnerDoc.data()?.userId !== ctx.userId) {
        throw new createCallable_1.HttpsError("permission-denied", "Partner belongs to a different user");
    }
    // Strip undefined values from nested objects (Firestore rejects them)
    const cleanActions = recordedActions.slice(0, 100).map((a) => JSON.parse(JSON.stringify(a)));
    const now = firestore_1.Timestamp.now(); // Can't use serverTimestamp() inside arrays
    const recipeId = `recipe_${domain.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}`;
    const newRecipe = {
        id: recipeId,
        startUrl,
        domain,
        recordedActions: cleanActions,
        requiresAuth,
        useCount: 0,
        autoRun: false,
        createdAt: now,
        updatedAt: now,
    };
    if (label)
        newRecipe.label = label;
    if (originTransactionId)
        newRecipe.originTransactionId = originTransactionId;
    // Upsert: replace existing recipe for the same domain, or append
    const existingRecipes = partnerDoc.data()?.browserRecipes || [];
    const existingIndex = existingRecipes.findIndex((r) => r.domain === domain);
    if (existingIndex >= 0) {
        // Replace existing recipe for this domain
        existingRecipes[existingIndex] = newRecipe;
        await partnerRef.update({
            browserRecipes: existingRecipes,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
    }
    else {
        // Append new recipe (cap at 20 recipes per partner)
        if (existingRecipes.length >= 20) {
            throw new createCallable_1.HttpsError("resource-exhausted", "Maximum 20 browser recipes per partner");
        }
        await partnerRef.update({
            browserRecipes: firestore_1.FieldValue.arrayUnion(newRecipe),
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
    }
    return { success: true, recipeId };
});
//# sourceMappingURL=saveBrowserRecipe.js.map