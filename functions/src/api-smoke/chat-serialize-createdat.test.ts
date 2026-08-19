/**
 * serializeMessagesForSDK date coercion (fork #123).
 *
 * The live-sync listener in components/chat/chat-provider.tsx runs every
 * snapshot through serializeMessagesForSDK. A `createdAt` that is present but
 * not a Firestore Timestamp used to reach `.toDate()` through an optional
 * chain that only guards null/undefined, throw a TypeError, and take the whole
 * onSnapshot listener down — not one rendered row, the way #53's two call
 * sites did.
 *
 * Covers repo-root lib/operations/chat-ops.ts, so it runs under
 * vitest.api-smoke.config.ts ONLY (needs the root node_modules).
 */

import { describe, it, expect, vi } from "vitest";

// chat-ops imports the browser Firebase SDK at module load for its read/write
// helpers. The pure serializer under test never touches any of them.
vi.mock("firebase/firestore", () => ({
  collection: () => ({}),
  query: () => ({}),
  orderBy: () => ({}),
  where: () => ({}),
  getDocs: async () => ({ docs: [] }),
  getDoc: async () => ({ exists: () => false }),
  doc: () => ({}),
  updateDoc: async () => undefined,
  addDoc: async () => ({ id: "new" }),
  deleteDoc: async () => undefined,
  Timestamp: { now: () => ({ toDate: () => new Date(0) }) },
  limit: () => ({}),
}));
vi.mock("@/lib/firebase/config", () => ({ functions: {}, db: {}, auth: {} }));

import { serializeMessagesForSDK } from "@/lib/operations/chat-ops";
import type { ChatMessage } from "@/types/chat";

function message(createdAt: unknown): ChatMessage {
  return {
    id: "m1",
    role: "user",
    content: "hello",
    createdAt,
  } as unknown as ChatMessage;
}

const AT = new Date("2026-08-19T10:00:00.000Z");

describe("serializeMessagesForSDK createdAt", () => {
  it("converts a Firestore Timestamp", () => {
    const ts = { toDate: () => AT };
    expect(serializeMessagesForSDK([message(ts)])[0].createdAt).toEqual(AT);
  });

  it("passes a Date through", () => {
    expect(serializeMessagesForSDK([message(AT)])[0].createdAt).toEqual(AT);
  });

  it("converts a {seconds, nanoseconds} shape that survived serialisation", () => {
    const raw = { seconds: Math.floor(AT.getTime() / 1000), nanoseconds: 0 };
    expect(serializeMessagesForSDK([message(raw)])[0].createdAt).toEqual(AT);
  });

  it("converts an ISO string", () => {
    expect(serializeMessagesForSDK([message(AT.toISOString())])[0].createdAt).toEqual(AT);
  });

  // The four shapes below are the ones that used to throw and kill the listener.
  it.each([
    ["a plain object", {}],
    ["an unparseable string", "not a date"],
    ["a number", 1_755_600_000_000],
    ["undefined", undefined],
  ])("degrades to undefined for %s instead of throwing", (_label, value) => {
    let out;
    expect(() => {
      out = serializeMessagesForSDK([message(value)]);
    }).not.toThrow();
    expect(out![0].createdAt).toBeUndefined();
  });

  it("does not abandon the remaining messages when one row is malformed", () => {
    const messages = [message({}), { ...message(AT), id: "m2" }] as ChatMessage[];
    const out = serializeMessagesForSDK(messages);
    expect(out).toHaveLength(2);
    expect(out[0].createdAt).toBeUndefined();
    expect(out[1].createdAt).toEqual(AT);
  });
});
