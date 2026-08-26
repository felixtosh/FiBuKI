/**
 * The transaction-side rejection reader (fork #102).
 *
 * The rule under test is that one rejection cannot half-hold: it is recorded in
 * two shapes, and every reader has to agree on whether it still stands. The
 * mirror of matching/__tests__/dismissedSuggestions.test.ts on the file side.
 */

import { describe, it, expect } from "vitest";
import { isActiveRejection, isFileRejected, readRejectedFileIds } from "../rejectedFiles";

describe("readRejectedFileIds", () => {
  it("reads the legacy id array", () => {
    expect([...readRejectedFileIds({ rejectedFileIds: ["f-1", "f-2"] })]).toEqual(["f-1", "f-2"]);
  });

  it("reads the record array", () => {
    const txData = { rejectedFiles: [{ fileId: "f-1", rejectedAt: new Date(), matchConfidence: 82 }] };
    expect([...readRejectedFileIds(txData)]).toEqual(["f-1"]);
  });

  it("unions the two shapes without duplicating", () => {
    const txData = {
      rejectedFileIds: ["f-1"],
      rejectedFiles: [{ fileId: "f-1" }, { fileId: "f-2" }],
    };
    expect([...readRejectedFileIds(txData)].sort()).toEqual(["f-1", "f-2"]);
  });

  it("skips a record the user took back", () => {
    const txData = {
      rejectedFiles: [
        { fileId: "f-1", rejectedAt: new Date(), unrejectedAt: new Date() },
        { fileId: "f-2", rejectedAt: new Date() },
      ],
    };
    expect([...readRejectedFileIds(txData)]).toEqual(["f-2"]);
  });

  it("still suppresses when one active record sits among reversed ones", () => {
    const txData = {
      rejectedFiles: [
        { fileId: "f-1", unrejectedAt: new Date() },
        { fileId: "f-1" },
      ],
    };
    expect(isFileRejected(txData, "f-1")).toBe(true);
  });

  it("survives absent, null and malformed input", () => {
    expect([...readRejectedFileIds(undefined)]).toEqual([]);
    expect([...readRejectedFileIds(null)]).toEqual([]);
    expect([...readRejectedFileIds({})]).toEqual([]);
    expect([...readRejectedFileIds({ rejectedFileIds: "f-1", rejectedFiles: 7 })]).toEqual([]);
    expect([...readRejectedFileIds({ rejectedFileIds: [null, "", 3, "f-1"] })]).toEqual(["f-1"]);
    expect([...readRejectedFileIds({ rejectedFiles: [null, {}, { fileId: 3 }, { fileId: "f-1" }] })]).toEqual(["f-1"]);
  });
});

describe("isActiveRejection", () => {
  it("treats absent and null unrejectedAt as active", () => {
    expect(isActiveRejection({ fileId: "f-1" })).toBe(true);
    expect(isActiveRejection({ fileId: "f-1", unrejectedAt: null })).toBe(true);
  });

  it("treats a stamped record as history", () => {
    expect(isActiveRejection({ fileId: "f-1", unrejectedAt: new Date() })).toBe(false);
  });
});
