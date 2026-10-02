import { describe, it, expect, vi, beforeEach } from "vitest";
import { store, createMockFirestore } from "../test/setup";

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => createMockFirestore(),
  FieldValue: {
    serverTimestamp: () => new Date(),
    increment: (n: number) => ({ __increment: n }),
  },
}));

const { admitEmail, recordRegistration } = await import("./registrationGate");
const db = createMockFirestore() as unknown as Parameters<typeof admitEmail>[0];

const ADMIN = "boss@example.test";
const rows = (collection: string) =>
  (store.queryDocs(collection, []) as Array<{ data: Record<string, unknown> }>).map((r) => r.data);

beforeEach(() => store.clear());

describe("admitEmail", () => {
  it("always admits the super admin, in any spelling", async () => {
    expect(await admitEmail(db, " Boss@Example.test ", ADMIN)).toEqual({ allowed: true, via: "super-admin" });
  });

  it("admits an invited email", async () => {
    store.setDoc("allowedEmails", "a", { email: "a@example.test" });
    expect(await admitEmail(db, "A@example.test", ADMIN)).toEqual({ allowed: true, via: "invite" });
  });

  it("refuses a stranger when no seats are configured", async () => {
    expect(await admitEmail(db, "x@example.test", ADMIN)).toEqual({ allowed: false, reason: "not-invited" });
  });

  it("refuses a stranger when the seats are used up, and writes nothing", async () => {
    store.setDoc("config", "openSeats", { totalSeats: 3, remainingSeats: 0, claimedSeats: 3 });
    expect(await admitEmail(db, "x@example.test", ADMIN)).toEqual({ allowed: false, reason: "not-invited" });
    expect(rows("allowedEmails")).toHaveLength(0);
  });

  it("lets a stranger claim an open seat: one seat spent, the email stays allowed", async () => {
    store.setDoc("config", "openSeats", { totalSeats: 3, remainingSeats: 2, claimedSeats: 1 });
    expect(await admitEmail(db, "New@Example.test", ADMIN)).toEqual({ allowed: true, via: "open-seat" });

    expect((store.getDoc("config", "openSeats") as { remainingSeats: number }).remainingSeats).toBe(1);
    expect(rows("allowedEmails")).toMatchObject([{ email: "new@example.test", addedBy: "open-seat" }]);

    // The same person coming back is an invitee now and does not spend a second seat.
    expect(await admitEmail(db, "new@example.test", ADMIN)).toEqual({ allowed: true, via: "invite" });
    expect((store.getDoc("config", "openSeats") as { remainingSeats: number }).remainingSeats).toBe(1);
  });

  it("refuses a used invite only where asked to (Firebase does, self-host re-creates after account deletion)", async () => {
    store.setDoc("allowedEmails", "a", { email: "a@example.test", usedAt: new Date() });
    expect(await admitEmail(db, "a@example.test", ADMIN, { rejectUsedInvite: true })).toEqual({
      allowed: false,
      reason: "invite-used",
    });
    expect(await admitEmail(db, "a@example.test", ADMIN)).toEqual({ allowed: true, via: "invite" });
  });
});

describe("recordRegistration", () => {
  it("marks the invite used, counts the registration and closes the person's pending request", async () => {
    store.setDoc("allowedEmails", "a", { email: "a@example.test" });
    store.setDoc("accessRequests", "r1", { email: "a@example.test", status: "pending" });
    store.setDoc("accessRequests", "r2", { email: "other@example.test", status: "pending" });

    await recordRegistration(db, "A@example.test", "uid-1", ADMIN);

    expect(store.getDoc("allowedEmails", "a")).toMatchObject({ registeredUserId: "uid-1" });
    expect((store.getDoc("allowedEmails", "a") as { usedAt?: unknown }).usedAt).toBeTruthy();
    expect(store.getDoc("accessRequests", "r1")).toMatchObject({ status: "dismissed", resolvedBy: "system:registration" });
    expect(store.getDoc("accessRequests", "r2")).toMatchObject({ status: "pending" });
    expect(store.getDoc("config", "openSeats")).toBeTruthy(); // the counter was written
  });

  it("does nothing for the super admin", async () => {
    await recordRegistration(db, ADMIN, "uid-0", ADMIN);
    expect(store.getDoc("config", "openSeats")).toBeFalsy();
  });
});
