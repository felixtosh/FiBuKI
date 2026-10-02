/**
 * Onboarding callables. The web app used to write the onboarding document straight
 * from the browser and decide in its own hook when a step was done. Both now happen
 * here (CLAUDE.md: every mutation goes through a Cloud Function), so the web app and
 * the MCP tools see one state.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import {
  ensureOnboarding,
  syncOnboarding,
  toStatus,
  updateOnboarding,
  type OnboardingAction,
  type OnboardingStatus,
} from "./onboardingState";
import { isOnboardingOrigin, isOnboardingStep, type OnboardingOrigin } from "./onboardingRules";

interface InitOnboardingRequest {
  /** Where the user signed up from. Only the call that creates the document records it. */
  origin?: OnboardingOrigin;
}

export const initOnboardingCallable = createCallable<InitOnboardingRequest, OnboardingStatus>(
  { name: "initOnboarding" },
  async (ctx, request) => {
    if (request?.origin !== undefined && !isOnboardingOrigin(request.origin)) {
      throw new HttpsError("invalid-argument", "origin is not a known origin");
    }
    const { state } = await ensureOnboarding(ctx.db, ctx.userId, request?.origin);
    return toStatus(state);
  }
);

export const syncOnboardingCallable = createCallable<Record<string, never>, OnboardingStatus>(
  { name: "syncOnboarding" },
  async (ctx) => toStatus(await syncOnboarding(ctx.db, ctx.userId))
);

interface UpdateOnboardingRequest {
  action: OnboardingAction["action"];
  step?: string;
}

export const updateOnboardingCallable = createCallable<UpdateOnboardingRequest, OnboardingStatus>(
  { name: "updateOnboarding" },
  async (ctx, request) => {
    let action: OnboardingAction;
    switch (request?.action) {
      case "skip_step":
        if (!isOnboardingStep(request.step)) {
          throw new HttpsError("invalid-argument", "step is not an onboarding step");
        }
        action = { action: "skip_step", step: request.step };
        break;
      case "skip_all":
      case "completion_seen":
      case "welcome_seen":
        action = { action: request.action };
        break;
      default:
        throw new HttpsError("invalid-argument", "unknown action");
    }
    return toStatus(await updateOnboarding(ctx.db, ctx.userId, action));
  }
);
