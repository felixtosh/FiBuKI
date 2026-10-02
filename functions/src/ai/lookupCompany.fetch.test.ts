/**
 * The company lookup fetches "<what the user typed>/impressum". That host is user input, so it goes through
 * the SSRF rules: a website of our own network's address must read nothing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({}),
  FieldValue: { serverTimestamp: () => new Date() },
  Timestamp: { now: () => new Date() },
}));
vi.mock("../utils/safeFetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/safeFetch")>();
  return { ...actual, fetchPublicUrl: vi.fn(actual.fetchPublicUrl) };
});

const { fetchPageContent } = await import("./lookupCompany");
const { fetchPublicUrl } = await import("../utils/safeFetch");
const fetchSpy = vi.mocked(fetchPublicUrl);

beforeEach(() => {
  fetchSpy.mockClear();
});

describe("fetchPageContent", () => {
  it.each([
    "https://169.254.169.254/impressum",
    "https://fibuki-api:8788/impressum",
    "https://localhost/impressum",
    "https://10.0.0.5/impressum",
    "https://postgres:5432/impressum",
    "https://seaweedfs:8333/impressum",
    "http://example.com/impressum",
    "https://example.com:8443/impressum",
  ])("reads nothing from %s", async (url) => {
    expect(await fetchPageContent(url)).toBeNull();
  });

  it("turns a public page into text, without scripts or styles, capped", async () => {
    const html = `<html><head><style>p{color:red}</style><script>alert(1)</script></head><body><p>Muster GmbH</p><p>${"x".repeat(20000)}</p></body></html>`;
    fetchSpy.mockResolvedValueOnce({ buffer: Buffer.from(html), contentType: "text/html", finalUrl: "https://muster.at/impressum" });
    const text = await fetchPageContent("https://muster.at/impressum");
    expect(text).toMatch(/^Muster GmbH x+/);
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
    expect(text!.length).toBe(15000);
    // Small and quick: it is a page of text, and it should not hold the caller up.
    expect(fetchSpy).toHaveBeenCalledWith("https://muster.at/impressum", { maxBytes: 1024 * 1024, timeoutMs: 5000 });
  });

  it("a page that cannot be fetched (error status, too large, timeout) is just no content", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("Failed to download file: 404"));
    expect(await fetchPageContent("https://muster.at/impressum")).toBeNull();
  });
});
