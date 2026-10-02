import { describe, it, expect, vi, beforeEach } from "vitest";
import { store, createMockFirestore } from "../test/setup";

vi.mock("firebase-admin/firestore", () => {
  class MockTimestamp {
    constructor(private readonly date: Date) {}
    static fromDate(d: Date) {
      return new MockTimestamp(d);
    }
    static now() {
      return new MockTimestamp(new Date());
    }
    toDate() {
      return this.date;
    }
  }
  return {
    getFirestore: () => createMockFirestore(),
    FieldValue: { serverTimestamp: () => new Date(), increment: (n: number) => n },
    Timestamp: MockTimestamp,
  };
});

const state = await import("./onboardingState");

const USER = "user-onb";
const db = createMockFirestore() as never;
const doc = () => store.getDoc(`users/${USER}/settings`, "onboarding") as Record<string, unknown> | undefined;

function seedTrialSubscription(extra: Record<string, unknown> = {}) {
  store.setDoc("subscriptions", USER, { plan: "free", ...extra });
}
const addSource = () => store.setDoc("sources", "src1", { userId: USER, isActive: true, name: "Konto" });
const addTx = (id: string, extra: Record<string, unknown> = {}) =>
  store.setDoc("transactions", id, { userId: USER, fileIds: [], partnerId: null, noReceiptCategoryId: null, ...extra });
const identify = () =>
  store.setDoc(`users/${USER}/settings`, "userData", { personalEntity: { id: "e1", name: "Max Muster" } });

describe("ensureOnboarding", () => {
  beforeEach(() => store.clear());

  it("creates the document once, at the first step, and records where the user came from", async () => {
    const first = await state.ensureOnboarding(db, USER, "chatgpt");
    expect(first.created).toBe(true);
    expect(doc()).toMatchObject({ isComplete: false, currentStep: "set_identity", origin: "chatgpt", welcomeSeen: false });
    expect(doc()).not.toHaveProperty("track");

    const second = await state.ensureOnboarding(db, USER, "claude");
    expect(second.created).toBe(false);
    expect(doc()?.origin).toBe("chatgpt"); // the origin of the creating call stays
  });

  it("starts the smart trial with it, for everyone", async () => {
    seedTrialSubscription();
    await state.ensureOnboarding(db, USER);
    expect(store.getDoc("subscriptions", USER)).toMatchObject({ trialTier: "smart", trialExpired: false, trialTransactionCount: 0 });
    expect(store.getDoc("subscriptions", USER)?.trialStartedAt).toBeTruthy();
  });

  it("does not restart a trial that began, or touch a paying customer", async () => {
    seedTrialSubscription({ trialStartedAt: "earlier", trialTier: "data" });
    await state.ensureOnboarding(db, USER);
    expect(store.getDoc("subscriptions", USER)?.trialTier).toBe("data");

    store.clear();
    seedTrialSubscription({ stripeSubscriptionId: "sub_1" });
    await state.ensureOnboarding(db, USER);
    expect(store.getDoc("subscriptions", USER)?.trialTier).toBeUndefined();
  });

  it("does not fail for a user without a subscription document", async () => {
    await expect(state.ensureOnboarding(db, USER)).resolves.toMatchObject({ created: true });
  });
});

describe("syncOnboarding", () => {
  beforeEach(() => store.clear());

  it("starts onboarding for a user who has none and completes nothing without data", async () => {
    const result = await state.syncOnboarding(db, USER);
    expect(result.currentStep).toBe("set_identity");
    expect(Object.keys(result.completedSteps)).toEqual([]);
  });

  it("completes identity from the user's data and moves to the next step", async () => {
    identify();
    const result = await state.syncOnboarding(db, USER);
    expect(result.completedSteps.set_identity).toBeTruthy();
    expect(result.currentStep).toBe("connect_email");
  });

  it("counts the legacy name fields as an identity", async () => {
    store.setDoc(`users/${USER}/settings`, "userData", { companyName: "Muster GmbH" });
    const result = await state.syncOnboarding(db, USER);
    expect(result.completedSteps.set_identity).toBeTruthy();
  });

  it("walks the whole chain from data, recording the record that triggered each step", async () => {
    identify();
    store.setDoc("emailIntegrations", "m1", { userId: USER, isActive: true, provider: "gmail" });
    addSource();
    addTx("t1");
    addTx("t2", { partnerId: "p1" });
    addTx("t3", { noReceiptCategoryId: "c1" });

    const result = await state.syncOnboarding(db, USER);
    expect(result.isComplete).toBe(true);
    expect(result.hasSeenCompletion).toBe(false); // the celebration is still owed
    expect(result.completedSteps.add_bank_account?.entityId).toBe("src1");
    expect(result.completedSteps.assign_partner?.entityId).toBe("t2");
    expect(result.completedSteps.attach_file?.entityId).toBe("t3");
  });

  it("a Mail Integration that is not Gmail, or not active, does not complete the email step", async () => {
    identify();
    store.setDoc("emailIntegrations", "m1", { userId: USER, isActive: true, provider: "imap" });
    store.setDoc("emailIntegrations", "m2", { userId: USER, isActive: false, provider: "gmail" });
    const result = await state.syncOnboarding(db, USER);
    expect(result.completedSteps.connect_email).toBeUndefined();
  });

  it("ignores other users' data", async () => {
    store.setDoc("sources", "foreign", { userId: "someone-else", isActive: true });
    identify();
    store.setDoc("emailIntegrations", "m1", { userId: USER, isActive: true, provider: "gmail" });
    const result = await state.syncOnboarding(db, USER);
    expect(result.completedSteps.add_bank_account).toBeUndefined();
  });

  it("never reopens a completed onboarding because of later data", async () => {
    await state.updateOnboarding(db, USER, { action: "skip_all" });
    const before = doc();
    addSource();
    const result = await state.syncOnboarding(db, USER);
    expect(result.isComplete).toBe(true);
    expect(doc()).toEqual(before);
  });

  it("is idempotent", async () => {
    identify();
    const a = await state.syncOnboarding(db, USER);
    const b = await state.syncOnboarding(db, USER);
    expect(b.completedSteps).toEqual(a.completedSteps);
  });

  it("retires the removed 'bank data only' track instead of reopening it with six steps", async () => {
    store.setDoc(`users/${USER}/settings`, "onboarding", {
      isComplete: false,
      track: "data_only",
      currentStep: "add_bank_account",
      completedSteps: {},
      startedAt: new Date(),
      completedAt: null,
      hasSeenCompletion: false,
    });
    const result = await state.syncOnboarding(db, USER);
    expect(result.isComplete).toBe(true);
    expect(result.hasSeenCompletion).toBe(true);
    expect(result.skippedAt).toBeTruthy();
  });
});

describe("updateOnboarding", () => {
  beforeEach(() => store.clear());

  it("skipping a step completes it, records the skip and moves on", async () => {
    const result = await state.updateOnboarding(db, USER, { action: "skip_step", step: "set_identity" });
    expect(result.completedSteps.set_identity).toBeTruthy();
    expect(result.skippedSteps?.set_identity).toBeTruthy();
    expect(result.currentStep).toBe("connect_email");
  });

  it("a skipped email step is not completed later by a Gmail connection", async () => {
    identify();
    await state.updateOnboarding(db, USER, { action: "skip_step", step: "connect_email" });
    store.setDoc("emailIntegrations", "m1", { userId: USER, isActive: true, provider: "gmail" });
    const result = await state.syncOnboarding(db, USER);
    expect(result.skippedSteps?.connect_email).toBeTruthy();
    expect(result.completedSteps.set_identity).toBeTruthy();
  });

  it("current step is the first one still open, even when a later step was skipped first", async () => {
    await state.updateOnboarding(db, USER, { action: "skip_step", step: "connect_email" });
    expect(doc()?.currentStep).toBe("set_identity");
    identify();
    const result = await state.syncOnboarding(db, USER);
    expect(result.currentStep).toBe("add_bank_account");
  });

  it("skipping the last step finishes onboarding only when nothing else is open", async () => {
    const early = await state.updateOnboarding(db, USER, { action: "skip_step", step: "attach_file" });
    expect(early.isComplete).toBe(false);
    expect(early.currentStep).toBe("set_identity");
    store.clear();
    store.setDoc(`users/${USER}/settings`, "onboarding", {
      ...state.newOnboardingDoc({ toDate: () => new Date() } as never, "web"),
      currentStep: "attach_file",
      completedSteps: { set_identity: {}, connect_email: {}, add_bank_account: {}, import_transactions: {}, assign_partner: {} },
    });
    const result = await state.updateOnboarding(db, USER, { action: "skip_step", step: "attach_file" });
    expect(result.isComplete).toBe(true);
  });

  it("skip_all completes every step, without a celebration", async () => {
    const result = await state.updateOnboarding(db, USER, { action: "skip_all" });
    expect(result).toMatchObject({ isComplete: true, hasSeenCompletion: true });
    expect(Object.keys(result.completedSteps)).toHaveLength(6);
  });

  it("records the welcome screen and the dismissed celebration", async () => {
    expect((await state.updateOnboarding(db, USER, { action: "welcome_seen" })).welcomeSeen).toBe(true);
    expect((await state.updateOnboarding(db, USER, { action: "completion_seen" })).hasSeenCompletion).toBe(true);
  });
});

describe("toStatus", () => {
  beforeEach(() => store.clear());

  it("lists every step with its state and where to do it", async () => {
    identify();
    await state.updateOnboarding(db, USER, { action: "skip_step", step: "connect_email" });
    const status = state.toStatus(await state.syncOnboarding(db, USER));
    expect(status.steps.map((s) => [s.id, s.state])).toEqual([
      ["set_identity", "done"],
      ["connect_email", "skipped"],
      ["add_bank_account", "open"],
      ["import_transactions", "open"],
      ["assign_partner", "open"],
      ["attach_file", "open"],
    ]);
    expect(status.currentStep).toBe("add_bank_account");
    expect(status.progress).toEqual({ done: 2, total: 6 });
    expect(status.steps[2].route).toBe("/sources");
    expect(status.origin).toBe("web");
  });

  it("a legacy user with a track has seen the welcome screen", () => {
    const legacy = { ...state.newOnboardingDoc({} as never, "web"), track: "full_service" as const };
    expect(state.toStatus(legacy).welcomeSeen).toBe(true);
  });
});
