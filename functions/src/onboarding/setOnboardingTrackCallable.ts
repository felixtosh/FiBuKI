import { createCallable, HttpsError } from "../utils/createCallable";
import { FieldValue } from "firebase-admin/firestore";

type OnboardingTrack = "data_only" | "full_service";

interface SetOnboardingTrackRequest {
  track: OnboardingTrack;
}

interface SetOnboardingTrackResponse {
  success: boolean;
}

export const setOnboardingTrackCallable = createCallable<
  SetOnboardingTrackRequest,
  SetOnboardingTrackResponse
>(
  { name: "setOnboardingTrack" },
  async (ctx, request) => {
    const { track } = request;

    if (track !== "data_only" && track !== "full_service") {
      throw new HttpsError("invalid-argument", "track must be 'data_only' or 'full_service'");
    }

    const onboardingRef = ctx.db
      .collection("users")
      .doc(ctx.userId)
      .collection("settings")
      .doc("onboarding");

    // Set track on onboarding doc
    const firstStep = track === "data_only" ? "add_bank_account" : "set_identity";
    await onboardingRef.set(
      {
        track,
        currentStep: firstStep,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // Initialize trial on subscription doc
    const subRef = ctx.db.collection("subscriptions").doc(ctx.userId);
    const subDoc = await subRef.get();

    if (subDoc.exists) {
      const sub = subDoc.data()!;
      // Only set trial if not already started and not already a paying customer
      if (!sub.trialStartedAt && !sub.stripeSubscriptionId) {
        const trialTier = track === "data_only" ? "data" : "smart";
        await subRef.update({
          trialTier,
          trialStartedAt: FieldValue.serverTimestamp(),
          trialTransactionCount: 0,
          trialExpired: false,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }

    return { success: true };
  }
);
