import { describe, it, expect, vi, beforeEach } from "vitest";
import { store, createMockFirestore } from "../test/setup";

/** The shared mock has no query methods on a bare collection ref, which the notifications subcollection sweep uses. */
function dbForDeletion() {
  const db = createMockFirestore();
  const collection = db.collection.bind(db);
  return {
    ...db,
    collection: (name: string) =>
      name.includes("/") ? {
            limit: () => ({ get: async () => ({ empty: true, docs: [] }) }),
            doc: () => ({ delete: async () => undefined, get: async () => ({ exists: false }) }),
          } : collection(name),
  };
}

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => createMockFirestore(),
  FieldValue: { serverTimestamp: () => new Date(), delete: () => undefined, increment: (n: number) => n },
  Timestamp: { now: () => new Date(), fromDate: (d: Date) => d },
}));
vi.mock("firebase-admin/auth", () => ({ getAuth: () => ({ deleteUser: vi.fn(async () => undefined) }) }));
vi.mock("firebase-admin/storage", () => ({
  getStorage: () => ({ bucket: () => ({ getFiles: async () => [[]], file: () => ({ delete: vi.fn() }) }) }),
}));

const { deleteUserData } = await import("./deleteUserAccountCallable");

beforeEach(() => store.clear());

describe("deleteUserData and connected assistants", () => {
  it("removes the user's API keys and OAuth connections, and only theirs", async () => {
    store.setDoc("apiKeys", "mine-key", { userId: "u1", name: "CLI" });
    store.setDoc("apiKeys", "mine-oauth", { userId: "u1", oauthClientId: "oc_1", oauthRefreshHash: "h" });
    store.setDoc("apiKeys", "theirs", { userId: "u2", name: "other" });

    const result = await deleteUserData(dbForDeletion() as never, "u1");

    expect(store.getDoc("apiKeys", "mine-key")).toBeFalsy();
    expect(store.getDoc("apiKeys", "mine-oauth")).toBeFalsy();
    expect(store.getDoc("apiKeys", "theirs")).toBeTruthy();
    expect(result.deletedCollections).toContain("apiKeys");
  });
});
