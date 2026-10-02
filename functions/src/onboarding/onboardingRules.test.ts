import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  deriveCompletions,
  nextStepAfter,
  ONBOARDING_STEP_IDS,
  isOnboardingOrigin,
  type OnboardingFacts,
  type OnboardingStepId,
} from "./onboardingRules";

const none: OnboardingFacts = {
  hasIdentity: false,
  hasGmailIntegration: false,
  firstSourceId: null,
  hasTransactions: false,
  partnerTransactionId: null,
  documentedTransactionId: null,
};

const derive = (
  completed: OnboardingStepId[],
  facts: Partial<OnboardingFacts>,
  skipped: OnboardingStepId[] = []
) => deriveCompletions(new Set(completed), new Set(skipped), { ...none, ...facts });

describe("deriveCompletions", () => {
  it("does nothing for a user with no data", () => {
    expect(derive([], {})).toEqual([]);
  });

  it("completes identity as soon as there is one", () => {
    expect(derive([], { hasIdentity: true })).toEqual([{ step: "set_identity" }]);
  });

  it("holds every later step until the email step is done or skipped", () => {
    expect(
      derive(["set_identity"], { hasIdentity: true, firstSourceId: "s1", hasTransactions: true })
    ).toEqual([]);
  });

  it("completes email on a Gmail Mail Integration, but not once the user skipped it", () => {
    expect(derive(["set_identity"], { hasGmailIntegration: true })).toEqual([{ step: "connect_email" }]);
    expect(derive(["set_identity"], { hasGmailIntegration: true }, ["connect_email"])).toEqual([]);
  });

  it("a skipped step counts as completed, so the next ones can follow", () => {
    expect(derive(["set_identity", "connect_email"], { firstSourceId: "s1" }, ["connect_email"])).toEqual([
      { step: "add_bank_account", entityId: "s1" },
    ]);
  });

  it("walks the whole chain in one pass when the data is already there", () => {
    const result = derive([], {
      hasIdentity: true,
      hasGmailIntegration: true,
      firstSourceId: "s1",
      hasTransactions: true,
      partnerTransactionId: "t1",
      documentedTransactionId: "t2",
    });
    expect(result.map((c) => c.step)).toEqual([...ONBOARDING_STEP_IDS]);
    expect(result.find((c) => c.step === "assign_partner")?.entityId).toBe("t1");
    expect(result.find((c) => c.step === "attach_file")?.entityId).toBe("t2");
  });

  it("transactions do not complete import before a Bank Account is done", () => {
    expect(derive(["set_identity", "connect_email"], { hasTransactions: true })).toEqual([]);
  });

  it("never re-completes a finished step", () => {
    expect(derive([...ONBOARDING_STEP_IDS], { hasIdentity: true, firstSourceId: "s1" })).toEqual([]);
  });
});

describe("steps", () => {
  it("nextStepAfter follows the order and ends with null", () => {
    expect(nextStepAfter("set_identity")).toBe("connect_email");
    expect(nextStepAfter("attach_file")).toBeNull();
  });

  it("match the client's UI config in types/onboarding.ts, in order", () => {
    const source = readFileSync(join(__dirname, "../../../types/onboarding.ts"), "utf8");
    const block = source.slice(source.indexOf("export const ONBOARDING_STEPS"));
    const clientIds = [...block.matchAll(/^\s{4}id: "([a-z_]+)"/gm)].map((m) => m[1]);
    expect(clientIds).toEqual([...ONBOARDING_STEP_IDS]);
  });
});

describe("origins", () => {
  it("accepts the known ones and nothing else", () => {
    expect(isOnboardingOrigin("chatgpt")).toBe(true);
    expect(isOnboardingOrigin("web")).toBe(true);
    expect(isOnboardingOrigin("gemini")).toBe(false);
    expect(isOnboardingOrigin(undefined)).toBe(false);
  });
});
