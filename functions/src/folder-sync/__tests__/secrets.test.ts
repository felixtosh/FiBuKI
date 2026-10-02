import { describe, expect, it } from "vitest";
import { buildProvider, type FolderRunnerSecrets } from "../folderSyncRunner";
import { FolderAuthError } from "../types";

const none: FolderRunnerSecrets = {
  dropboxAppKey: "",
  dropboxAppSecret: "",
  googleClientId: "",
  googleClientSecret: "",
  encryptionKey: "a".repeat(64),
};

describe("buildProvider with a partly configured server", () => {
  it("builds Drive when only Google is configured", () => {
    expect(() => buildProvider("gdrive", "RT", { ...none, googleClientId: "i", googleClientSecret: "s" })).not.toThrow();
  });

  it("builds Dropbox when only Dropbox is configured", () => {
    expect(() => buildProvider("dropbox", "RT", { ...none, dropboxAppKey: "k", dropboxAppSecret: "s" })).not.toThrow();
  });

  it("an unconfigured provider is a server error, not a reason to ask the user to reconnect", () => {
    for (const p of ["dropbox", "gdrive"] as const) {
      let error: unknown;
      try {
        buildProvider(p, "RT", none);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(FolderAuthError);
      expect(String(error)).toContain("not configured");
    }
  });
});
