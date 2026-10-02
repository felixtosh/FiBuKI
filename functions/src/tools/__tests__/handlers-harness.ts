/**
 * Shared mocks and setup for the tool-handler tests (handlers.*.test.ts).
 *
 * vi.mock has to be called in each test file (it is hoisted per file), so the
 * files call it with these factories: the mocks themselves live here, once.
 *
 *   vi.mock("firebase-admin/firestore", () => firestoreMock());
 *   vi.mock("../../extraction/extractionCore", () => extractionCoreMock(extraction));
 *   vi.mock("firebase-functions/params", () => paramsMock());
 */

import { createMockFirestore } from "../../test/setup";

/** Minimal Timestamp stand-in. The in-memory store compares values via toDate()/getTime(). */
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

export function firestoreMock() {
  return {
    getFirestore: () => createMockFirestore(),
    FieldValue: {
      serverTimestamp: () => new Date(),
      arrayUnion: (...elements: unknown[]) => ({ elements, constructor: { name: "ArrayUnionTransform" } }),
      arrayRemove: (...elements: unknown[]) => ({ elements, constructor: { name: "ArrayRemoveTransform" } }),
      increment: (n: number) => n,
      delete: () => ({ constructor: { name: "DeleteTransform" } }),
    },
    Timestamp: MockTimestamp,
  };
}

/**
 * retry_file_extraction is the one tool that spends an AI call: the model
 * boundary is mocked, the eligibility rule and the writes are the real ones.
 * Pass the file's vi.hoisted holder so its tests can assert on the calls.
 */
export function extractionCoreMock(holder: { runExtraction: (...args: unknown[]) => unknown }) {
  return { runExtraction: (...args: unknown[]) => holder.runExtraction(...args) };
}

export function paramsMock() {
  return { defineSecret: (name: string) => ({ value: () => `test-${name}` }) };
}

export const userId = "test-user-123";
export const otherUserId = "other-user-456";
