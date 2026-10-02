/**
 * get_onboarding_status, skip_onboarding_step and create_identity_entity: the tools a
 * plugin uses to set a new user up without opening fibuki.com first.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { store, createMockFirestore } from "../../test/setup";

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
    valueOf() {
      return this.date.getTime();
    }
  }
  return {
    getFirestore: () => createMockFirestore(),
    FieldValue: { serverTimestamp: () => new Date(), increment: (n: number) => n },
    Timestamp: MockTimestamp,
  };
});
vi.mock("firebase-admin/storage", () => ({ getStorage: () => ({ bucket: () => ({}) }) }));
vi.mock("firebase-functions/params", () => ({
  defineSecret: (name: string) => ({ value: () => `test-${name}` }),
}));

const handlers = await import("../handlers");

const USER = "user-tools";
const tool = (name: string, args: Record<string, unknown> = {}) => handlers.handleTool(USER, name, args) as Promise<any>;
const userData = () => store.getDoc(`users/${USER}/settings`, "userData") as Record<string, any> | undefined;

describe("create_identity_entity", () => {
  beforeEach(() => store.clear());

  it("creates the personal entity for a user with no identity, with the settings page's shape and defaults", async () => {
    const result = await tool("create_identity_entity", {
      type: "person",
      name: "  Max Muster ",
      vatId: "atu 12345678",
      ibans: ["AT61 1904 3002 3457 3201"],
      aliases: ["M. Muster", ""],
    });
    expect(result.success).toBe(true);

    const entity = userData()!.personalEntity;
    expect(entity).toMatchObject({
      id: result.entityId,
      type: "person",
      name: "Max Muster",
      vatId: "ATU12345678",
      ibans: ["AT611904300234573201"],
      aliases: ["M. Muster"],
      order: 0,
    });
    expect(entity.createdAt).toBeTruthy();
    expect(userData()).toMatchObject({ country: "AT", taxNumber: "", ownEmails: [] });
  });

  it("adds companies in order and refuses a duplicate name", async () => {
    await tool("create_identity_entity", { type: "person", name: "Max Muster" });
    await tool("create_identity_entity", { type: "company", name: "Muster Consulting GmbH", address: { city: "Wien", country: "at" } });
    await tool("create_identity_entity", { type: "company", name: "Zweite KG" });

    expect(userData()!.companies.map((c: any) => [c.name, c.order])).toEqual([
      ["Muster Consulting GmbH", 0],
      ["Zweite KG", 1],
    ]);
    expect(userData()!.companies[0].address).toEqual({ city: "Wien", country: "AT" });
    expect(userData()!.personalEntity.name).toBe("Max Muster");

    await expect(tool("create_identity_entity", { type: "company", name: "muster consulting gmbh" })).rejects.toThrow(/already exists/);
  });

  it("refuses a second personal entity and bad input", async () => {
    await tool("create_identity_entity", { type: "person", name: "Max Muster" });
    await expect(tool("create_identity_entity", { type: "person", name: "Other" })).rejects.toThrow(/update_identity_entity/);
    await expect(tool("create_identity_entity", { type: "robot", name: "x" })).rejects.toThrow(/type must be/);
    await expect(tool("create_identity_entity", { type: "person", name: "   " })).rejects.toThrow(/name is required/);
  });

  it("leaves the rest of an existing user data document alone", async () => {
    store.setDoc(`users/${USER}/settings`, "userData", { country: "DE", taxNumber: "123", ownEmails: ["a@b.at"], createdAt: "earlier" });
    await tool("create_identity_entity", { type: "company", name: "Muster GmbH" });
    expect(userData()).toMatchObject({ country: "DE", taxNumber: "123", ownEmails: ["a@b.at"], createdAt: "earlier" });
  });

  it("update_identity_entity still patches what create made, through the shared normalisation", async () => {
    const { entityId } = await tool("create_identity_entity", { type: "company", name: "Muster GmbH" });
    await tool("update_identity_entity", { entityId, patch: { vatId: "atu 99999999", ibans: ["at61 1904 3002 3457 3201"] } });
    expect(userData()!.companies[0]).toMatchObject({ vatId: "ATU99999999", ibans: ["AT611904300234573201"] });
  });
});

describe("get_onboarding_status", () => {
  beforeEach(() => store.clear());

  it("starts onboarding for a new user: all open, remembered as coming through the API by default", async () => {
    const status = await tool("get_onboarding_status");
    expect(status).toMatchObject({ complete: false, origin: "api", currentStep: "set_identity", progress: { done: 0, total: 6 } });
    expect(status.steps.every((s: any) => s.state === "open")).toBe(true);
    expect(status.steps[0].route).toBe("/settings/identity");
  });

  it("remembers the assistant the user came through, only the first time", async () => {
    expect((await tool("get_onboarding_status", { origin: "chatgpt" })).origin).toBe("chatgpt");
    expect((await tool("get_onboarding_status", { origin: "claude" })).origin).toBe("chatgpt");
  });

  it("ignores an unknown origin instead of failing", async () => {
    expect((await tool("get_onboarding_status", { origin: "gemini" })).origin).toBe("api");
  });

  it("creating the identity completes the step on the next look", async () => {
    await tool("get_onboarding_status");
    await tool("create_identity_entity", { type: "person", name: "Max Muster" });
    const status = await tool("get_onboarding_status");
    expect(status.steps[0].state).toBe("done");
    expect(status.currentStep).toBe("connect_email");
    expect(status.progress.done).toBe(1);
  });
});

describe("skip_onboarding_step", () => {
  beforeEach(() => store.clear());

  it("skips the mailbox step on the user's say-so and reports it as skipped", async () => {
    const status = await tool("skip_onboarding_step", { step: "connect_email" });
    expect(status.steps.find((s: any) => s.id === "connect_email").state).toBe("skipped");
  });

  it("rejects a step that does not exist", async () => {
    await expect(tool("skip_onboarding_step", { step: "test_integration" })).rejects.toThrow(/not an onboarding step/);
  });
});
