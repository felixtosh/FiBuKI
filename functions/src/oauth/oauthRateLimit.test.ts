import { describe, it, expect, vi, beforeEach } from "vitest";
import { store, createMockFirestore } from "../test/setup";

vi.mock("firebase-admin/firestore", () => {
  class FakeInstant {
    constructor(private readonly ms: number) {}
    static fromMillis(ms: number) {
      return new FakeInstant(ms);
    }
    toMillis() {
      return this.ms;
    }
  }
  return { getFirestore: () => createMockFirestore(), Timestamp: FakeInstant };
});

const { takeRegistrationSlot, clientAddress, REGISTER_PER_ADDRESS, REGISTER_GLOBAL, WINDOW_MS } = await import("./oauthRateLimit");
const db = createMockFirestore() as never;
const NOW = 10 * WINDOW_MS + 5 * 60_000; // five minutes into a window

beforeEach(() => store.clear());

describe("takeRegistrationSlot", () => {
  it("allows up to the per-address cap, then refuses with the time left in the window", async () => {
    for (let i = 0; i < REGISTER_PER_ADDRESS; i++) {
      expect((await takeRegistrationSlot(db, "203.0.113.1", NOW)).allowed).toBe(true);
    }
    const refused = await takeRegistrationSlot(db, "203.0.113.1", NOW);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(55 * 60);
  });

  it("limits each address separately", async () => {
    for (let i = 0; i < REGISTER_PER_ADDRESS; i++) await takeRegistrationSlot(db, "203.0.113.1", NOW);
    expect((await takeRegistrationSlot(db, "203.0.113.2", NOW)).allowed).toBe(true);
  });

  it("a new window starts from zero", async () => {
    for (let i = 0; i < REGISTER_PER_ADDRESS; i++) await takeRegistrationSlot(db, "203.0.113.1", NOW);
    expect((await takeRegistrationSlot(db, "203.0.113.1", NOW + WINDOW_MS)).allowed).toBe(true);
  });

  it("has a global ceiling that many different addresses cannot get around", async () => {
    store.setDoc("oauthRateLimits", `register-${Math.floor(NOW / WINDOW_MS)}-all`, { count: REGISTER_GLOBAL });
    expect((await takeRegistrationSlot(db, "198.51.100.77", NOW)).allowed).toBe(false);
  });

  it("stores the address only as a hash", async () => {
    await takeRegistrationSlot(db, "203.0.113.1", NOW);
    const ids = (store.queryDocs("oauthRateLimits", []) as Array<{ id: string }>).map((d) => d.id);
    expect(ids.some((id) => id.includes("203.0.113.1"))).toBe(false);
    expect(ids).toHaveLength(2);
  });

  it("treats a request with no address as one shared bucket instead of letting it through unlimited", async () => {
    for (let i = 0; i < REGISTER_PER_ADDRESS; i++) await takeRegistrationSlot(db, null, NOW);
    expect((await takeRegistrationSlot(db, null, NOW)).allowed).toBe(false);
  });
});

describe("clientAddress", () => {
  it("takes the first forwarded entry", () => {
    expect(clientAddress({ "x-forwarded-for": "203.0.113.1, 10.0.0.2" })).toBe("203.0.113.1");
    expect(clientAddress({ "x-forwarded-for": ["198.51.100.4"] })).toBe("198.51.100.4");
  });

  it("is null when absent, empty or absurdly long", () => {
    expect(clientAddress({})).toBeNull();
    expect(clientAddress(undefined)).toBeNull();
    expect(clientAddress({ "x-forwarded-for": "" })).toBeNull();
    expect(clientAddress({ "x-forwarded-for": "x".repeat(200) })).toBeNull();
  });
});
