/**
 * Tests for URL utility functions
 */

const {
  hostMatches,
  shouldTrackRequest,
  isLoginChallenge,
  isLoginPage,
  extractDomain,
  looksLikeDownload,
  isSameOrigin,
} = require("../lib/url-utils");

describe("URL Utils", () => {
  describe("hostMatches", () => {
    it("matches exact hostname", () => {
      expect(
        hostMatches("https://payments.google.com/doc", "payments.google.com")
      ).toBe(true);
    });

    it("matches subdomains", () => {
      expect(
        hostMatches("https://eu.payments.google.com/doc", "payments.google.com")
      ).toBe(true);
    });

    it("rejects the hostname embedded in path or query", () => {
      expect(
        hostMatches(
          "https://evil.com/payments.google.com",
          "payments.google.com"
        )
      ).toBe(false);
      expect(
        hostMatches(
          "https://evil.com/?next=payments.google.com",
          "payments.google.com"
        )
      ).toBe(false);
    });

    it("rejects lookalike hostnames", () => {
      expect(
        hostMatches(
          "https://payments.google.com.evil.com/doc",
          "payments.google.com"
        )
      ).toBe(false);
      expect(
        hostMatches("https://notpayments.google.com/doc", "payments.google.com")
      ).toBe(false);
    });

    it("returns false for unparseable or empty input", () => {
      expect(hostMatches("not a url", "payments.google.com")).toBe(false);
      expect(hostMatches("", "payments.google.com")).toBe(false);
      expect(hostMatches(null, "payments.google.com")).toBe(false);
    });
  });

  describe("shouldTrackRequest", () => {
    it("returns true for Google Payments PDF URLs", () => {
      expect(
        shouldTrackRequest(
          "https://payments.google.com/payments/apis-secure/doc/123"
        )
      ).toBe(true);
    });

    it("returns true for URLs with doc= parameter", () => {
      expect(
        shouldTrackRequest("https://payments.google.com/something?doc=123")
      ).toBe(true);
      expect(shouldTrackRequest("https://example.com/download?doc=abc")).toBe(
        true
      );
    });

    it("returns false for non-PDF URLs", () => {
      expect(shouldTrackRequest("https://example.com/page")).toBe(false);
      expect(shouldTrackRequest("https://google.com/search")).toBe(false);
    });

    it("does not treat payments.google.com in the path as the host", () => {
      expect(
        shouldTrackRequest(
          "https://evil.com/payments.google.com/apis-secure/doc/123"
        )
      ).toBe(false);
    });

    it("returns false for empty/null URLs", () => {
      expect(shouldTrackRequest("")).toBe(false);
      expect(shouldTrackRequest(null)).toBe(false);
      expect(shouldTrackRequest(undefined)).toBe(false);
    });

    it("handles case insensitivity", () => {
      expect(
        shouldTrackRequest(
          "https://PAYMENTS.GOOGLE.COM/payments/APIS-SECURE/DOC/123"
        )
      ).toBe(true);
    });
  });

  describe("isLoginChallenge", () => {
    it("detects Google signin challenge URLs", () => {
      expect(
        isLoginChallenge(
          "https://accounts.google.com/v3/signin/challenge/something"
        )
      ).toBe(true);
      expect(
        isLoginChallenge(
          "https://accounts.google.com/v3/signin/challenge/pwd"
        )
      ).toBe(true);
    });

    it("returns false for non-challenge URLs", () => {
      expect(isLoginChallenge("https://accounts.google.com/signin")).toBe(
        false
      );
      expect(isLoginChallenge("https://payments.google.com/billing")).toBe(
        false
      );
      expect(isLoginChallenge("https://example.com/login")).toBe(false);
    });

    it("returns false for empty/null URLs", () => {
      expect(isLoginChallenge("")).toBe(false);
      expect(isLoginChallenge(null)).toBe(false);
      expect(isLoginChallenge(undefined)).toBe(false);
    });
  });

  describe("isLoginPage", () => {
    it("detects login page patterns", () => {
      expect(isLoginPage("https://example.com/login")).toBe(true);
      expect(isLoginPage("https://example.com/signin")).toBe(true);
      expect(isLoginPage("https://example.com/auth/callback")).toBe(true);
      expect(isLoginPage("https://example.com/oauth2/authorize")).toBe(true);
      expect(isLoginPage("https://accounts.google.com/anything")).toBe(true);
    });

    it("returns false for non-login pages", () => {
      expect(isLoginPage("https://example.com/dashboard")).toBe(false);
      expect(isLoginPage("https://example.com/billing")).toBe(false);
    });

    it("returns false for empty/null URLs", () => {
      expect(isLoginPage("")).toBe(false);
      expect(isLoginPage(null)).toBe(false);
    });
  });

  describe("extractDomain", () => {
    it("extracts domain from URL", () => {
      expect(extractDomain("https://example.com/path")).toBe("example.com");
      expect(extractDomain("https://sub.example.com/path")).toBe(
        "sub.example.com"
      );
    });

    it("removes www prefix", () => {
      expect(extractDomain("https://www.example.com/path")).toBe("example.com");
    });

    it("returns empty string for invalid URLs", () => {
      expect(extractDomain("not-a-url")).toBe("");
      expect(extractDomain("")).toBe("");
      expect(extractDomain(null)).toBe("");
    });
  });

  describe("looksLikeDownload", () => {
    it("detects PDF file extensions", () => {
      expect(looksLikeDownload("https://example.com/invoice.pdf")).toBe(true);
      expect(looksLikeDownload("https://example.com/doc.pdf?v=1")).toBe(true);
    });

    it("detects download-related URL patterns", () => {
      expect(looksLikeDownload("https://example.com/download/123")).toBe(true);
      expect(looksLikeDownload("https://example.com/export?id=abc")).toBe(true);
      expect(looksLikeDownload("https://example.com/invoice/view")).toBe(true);
      expect(looksLikeDownload("https://example.com/receipt/123")).toBe(true);
    });

    it("returns false for regular URLs", () => {
      expect(looksLikeDownload("https://example.com/page")).toBe(false);
      expect(looksLikeDownload("https://example.com/about")).toBe(false);
    });

    it("returns false for empty/null URLs", () => {
      expect(looksLikeDownload("")).toBe(false);
      expect(looksLikeDownload(null)).toBe(false);
    });
  });

  describe("isSameOrigin", () => {
    it("returns true for same origin URLs", () => {
      expect(
        isSameOrigin(
          "https://example.com/path",
          "https://example.com"
        )
      ).toBe(true);
      expect(
        isSameOrigin(
          "https://example.com/other/path",
          "https://example.com"
        )
      ).toBe(true);
    });

    it("returns false for different origins", () => {
      expect(
        isSameOrigin(
          "https://other.com/path",
          "https://example.com"
        )
      ).toBe(false);
      expect(
        isSameOrigin(
          "http://example.com/path",
          "https://example.com"
        )
      ).toBe(false);
    });

    it("returns false for invalid inputs", () => {
      expect(isSameOrigin("", "https://example.com")).toBe(false);
      expect(isSameOrigin("https://example.com", "")).toBe(false);
      expect(isSameOrigin(null, null)).toBe(false);
    });
  });
});
