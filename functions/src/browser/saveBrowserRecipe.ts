/**
 * Save a browser recipe to a UserPartner.
 * Called after learn mode completes — upserts by domain (one recipe per domain per partner).
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

interface RecordedAction {
  step: number;
  actionType: string;
  url: string;
  targetUrl?: string;
  clickTarget?: {
    text: string;
    tagName: string;
    ariaLabel?: string;
    href?: string;
    selector?: string;
    contextText?: string;
  };
  inputValue?: string;
  pageContext?: {
    title: string;
    surroundingText: string;
  };
  relativeTimeMs: number;
}

interface SaveBrowserRecipeRequest {
  partnerId: string;
  startUrl: string;
  domain: string;
  recordedActions: RecordedAction[];
  requiresAuth: boolean;
  originTransactionId?: string;
  label?: string;
}

interface SaveBrowserRecipeResponse {
  success: boolean;
  recipeId: string;
}

export const saveBrowserRecipeCallable = createCallable<
  SaveBrowserRecipeRequest,
  SaveBrowserRecipeResponse
>(
  { name: "saveBrowserRecipe" },
  async (ctx, request) => {
    const {
      partnerId,
      startUrl,
      domain,
      recordedActions,
      requiresAuth,
      originTransactionId,
      label,
    } = request;

    if (!partnerId) {
      throw new HttpsError("invalid-argument", "partnerId is required");
    }
    if (!startUrl) {
      throw new HttpsError("invalid-argument", "startUrl is required");
    }
    if (!domain) {
      throw new HttpsError("invalid-argument", "domain is required");
    }
    if (!recordedActions || recordedActions.length === 0) {
      throw new HttpsError(
        "invalid-argument",
        "recordedActions must not be empty"
      );
    }

    // Verify partner belongs to user
    const partnerRef = ctx.db.collection("partners").doc(partnerId);
    const partnerDoc = await partnerRef.get();

    if (!partnerDoc.exists) {
      throw new HttpsError("not-found", "Partner not found");
    }
    if (partnerDoc.data()?.userId !== ctx.userId) {
      throw new HttpsError(
        "permission-denied",
        "Partner belongs to a different user"
      );
    }

    // Strip undefined values from nested objects (Firestore rejects them)
    const cleanActions = recordedActions.slice(0, 100).map((a) =>
      JSON.parse(JSON.stringify(a))
    );

    const now = Timestamp.now(); // Can't use serverTimestamp() inside arrays
    const recipeId = `recipe_${domain.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}`;

    const newRecipe: Record<string, unknown> = {
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
    if (label) newRecipe.label = label;
    if (originTransactionId) newRecipe.originTransactionId = originTransactionId;

    // Upsert: replace existing recipe for the same domain, or append
    const existingRecipes: Array<{ domain: string }> =
      partnerDoc.data()?.browserRecipes || [];
    const existingIndex = existingRecipes.findIndex(
      (r) => r.domain === domain
    );

    if (existingIndex >= 0) {
      // Replace existing recipe for this domain
      existingRecipes[existingIndex] = newRecipe as never;
      await partnerRef.update({
        browserRecipes: existingRecipes,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      // Append new recipe (cap at 20 recipes per partner)
      if (existingRecipes.length >= 20) {
        throw new HttpsError(
          "resource-exhausted",
          "Maximum 20 browser recipes per partner"
        );
      }
      await partnerRef.update({
        browserRecipes: FieldValue.arrayUnion(newRecipe),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    return { success: true, recipeId };
  }
);
