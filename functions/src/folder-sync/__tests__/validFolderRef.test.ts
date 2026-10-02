import { describe, expect, it } from "vitest";
import { validFolderRef } from "../folderIntegrationCallables";

describe("validFolderRef", () => {
  it("Dropbox: the root or an absolute path without traversal", () => {
    expect(validFolderRef("dropbox", "")).toBe(true);
    expect(validFolderRef("dropbox", "/Belege/2026")).toBe(true);
    expect(validFolderRef("dropbox", "Belege")).toBe(false);
    expect(validFolderRef("dropbox", "/a/../b")).toBe(false);
    expect(validFolderRef("dropbox", 5)).toBe(false);
  });

  it("Drive: an id, never a query fragment", () => {
    expect(validFolderRef("gdrive", "root")).toBe(true);
    expect(validFolderRef("gdrive", "1AbC_d-9")).toBe(true);
    expect(validFolderRef("gdrive", "")).toBe(false);
    expect(validFolderRef("gdrive", "x' or '1'='1")).toBe(false);
    expect(validFolderRef("gdrive", "a".repeat(101))).toBe(false);
  });
});
