import { describe, it, expect } from "vitest";
import { hintedEmail, safeRedirectPath } from "@/lib/auth/safe-redirect";

describe("safeRedirectPath", () => {
  it("keeps a path on this site, with its query", () => {
    expect(safeRedirectPath("/oauth/authorize?client_id=oc_1&state=a%2Fb")).toBe("/oauth/authorize?client_id=oc_1&state=a%2Fb");
    expect(safeRedirectPath("/transactions")).toBe("/transactions");
  });

  it("falls back for anything that could leave the site", () => {
    for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "evil", "", null, undefined, "/\t/evil.example", "/\n/evil"]) {
      expect(safeRedirectPath(bad)).toBe("/transactions");
    }
    expect(safeRedirectPath("//evil.example", "/welcome")).toBe("/welcome");
  });
});

describe("hintedEmail", () => {
  it("passes a plausible address and drops anything else", () => {
    expect(hintedEmail(" max@example.at ")).toBe("max@example.at");
    expect(hintedEmail("not an email")).toBe("");
    expect(hintedEmail("a@b c")).toBe("");
    expect(hintedEmail(null)).toBe("");
    expect(hintedEmail("x".repeat(260) + "@a.at")).toBe("");
  });
});
