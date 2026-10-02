import { describe, it, expect, vi, beforeEach } from "vitest";
import { store, createMockFirestore } from "../test/setup";

vi.mock("firebase-admin/firestore", () => {
  class FakeInstant {
    constructor(private readonly ms: number) {}
    static fromMillis(ms: number) {
      return new FakeInstant(ms);
    }
    static now() {
      return new FakeInstant(Date.now());
    }
    toDate() {
      return new Date(this.ms);
    }
    toMillis() {
      return this.ms;
    }
    valueOf() {
      return this.ms;
    }
  }
  return { getFirestore: () => createMockFirestore(), Timestamp: FakeInstant };
});
vi.mock("firebase-functions/v2/scheduler", () => ({ onSchedule: (_o: unknown, fn: unknown) => fn }));

const { cleanupOAuthRecords, CODE_RETENTION_AFTER_EXPIRY_MS, UNUSED_CLIENT_MAX_AGE_MS } = await import("./cleanupOAuth");
const { Timestamp } = await import("firebase-admin/firestore");

const db = createMockFirestore() as never;
const NOW = Date.UTC(2026, 9, 2);
const at = (msAgo: number) => Timestamp.fromMillis(NOW - msAgo);
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => store.clear());

describe("cleanupOAuthRecords", () => {
  it("removes codes a day after they expired, keeps newer ones (a used code still detects reuse)", async () => {
    store.setDoc("oauthCodes", "old", { expiresAt: at(CODE_RETENTION_AFTER_EXPIRY_MS + 60_000), usedAt: null });
    store.setDoc("oauthCodes", "old-used", { expiresAt: at(2 * DAY), usedAt: at(2 * DAY) });
    store.setDoc("oauthCodes", "recent-expired", { expiresAt: at(60 * 60 * 1000), usedAt: at(60 * 60 * 1000) });
    store.setDoc("oauthCodes", "live", { expiresAt: Timestamp.fromMillis(NOW + 5 * 60_000), usedAt: null });

    const result = await cleanupOAuthRecords(db, NOW);

    expect(result.codesDeleted).toBe(2);
    expect(store.getDoc("oauthCodes", "old")).toBeFalsy();
    expect(store.getDoc("oauthCodes", "old-used")).toBeFalsy();
    expect(store.getDoc("oauthCodes", "recent-expired")).toBeTruthy();
    expect(store.getDoc("oauthCodes", "live")).toBeTruthy();
  });

  it("removes old clients nobody was ever granted, keeps young ones and any that has a grant", async () => {
    store.setDoc("oauthClients", "stale", { clientName: "spam", createdAt: at(UNUSED_CLIENT_MAX_AGE_MS + DAY) });
    store.setDoc("oauthClients", "young", { clientName: "new", createdAt: at(DAY) });
    store.setDoc("oauthClients", "granted-old", { clientName: "ChatGPT", createdAt: at(UNUSED_CLIENT_MAX_AGE_MS + DAY) });
    store.setDoc("apiKeys", "grant-1", { userId: "u", oauthClientId: "granted-old", revokedAt: null });
    store.setDoc("oauthClients", "revoked-grant-old", { clientName: "Old app", createdAt: at(UNUSED_CLIENT_MAX_AGE_MS + DAY) });
    store.setDoc("apiKeys", "grant-2", { userId: "u", oauthClientId: "revoked-grant-old", revokedAt: at(DAY) });

    const result = await cleanupOAuthRecords(db, NOW);

    expect(result.clientsDeleted).toBe(1);
    expect(store.getDoc("oauthClients", "stale")).toBeFalsy();
    expect(store.getDoc("oauthClients", "young")).toBeTruthy();
    expect(store.getDoc("oauthClients", "granted-old")).toBeTruthy();
    expect(store.getDoc("oauthClients", "revoked-grant-old")).toBeTruthy();
  });

  it("does nothing on an empty store", async () => {
    expect(await cleanupOAuthRecords(db, NOW)).toEqual({ codesDeleted: 0, clientsDeleted: 0, rateWindowsDeleted: 0 });
  });

  it("removes finished rate-limit windows and keeps the current one", async () => {
    store.setDoc("oauthRateLimits", "done", { count: 5, windowEnd: at(60_000) });
    store.setDoc("oauthRateLimits", "current", { count: 1, windowEnd: Timestamp.fromMillis(NOW + 60_000) });
    const result = await cleanupOAuthRecords(db, NOW);
    expect(result.rateWindowsDeleted).toBe(1);
    expect(store.getDoc("oauthRateLimits", "done")).toBeFalsy();
    expect(store.getDoc("oauthRateLimits", "current")).toBeTruthy();
  });
});
