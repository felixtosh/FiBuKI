/**
 * upload_file with a url. The URL is supplied by whoever calls the tool, so it is fetched
 * under the SSRF rules (utils/safeFetch.ts): nothing private, nothing but public https.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { store, createMockFirestore } from "../../test/setup";

vi.mock("firebase-admin/firestore", () => {
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
  return {
    getFirestore: () => createMockFirestore(),
    FieldValue: { serverTimestamp: () => new Date(), increment: (n: number) => n },
    Timestamp: MockTimestamp,
  };
});

const storage = vi.hoisted(() => ({ save: vi.fn(async () => undefined), fileFn: vi.fn() }));
vi.mock("firebase-admin/storage", () => ({
  getStorage: () => ({
    bucket: () => ({
      name: "test-bucket",
      file: (path: string) => {
        storage.fileFn(path);
        return { save: storage.save, delete: vi.fn(), exists: vi.fn(async () => [true]) };
      },
    }),
  }),
}));
vi.mock("firebase-functions/params", () => ({
  defineSecret: (name: string) => ({ value: () => `test-${name}` }),
}));
// The real checks run; only the network call that follows a passed check is replaced.
vi.mock("../../utils/safeFetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/safeFetch")>();
  return { ...actual, fetchPublicUrl: vi.fn(actual.fetchPublicUrl) };
});

const handlers = await import("../handlers");
const { fetchPublicUrl } = await import("../../utils/safeFetch");
const { TOOL_DEFINITIONS } = await import("../definitions");

const USER = "user-upload";
const upload = (args: Record<string, unknown>) => handlers.handleTool(USER, "upload_file", { fileName: "a.pdf", mimeType: "application/pdf", ...args }) as Promise<any>;
const fetchSpy = vi.mocked(fetchPublicUrl);

beforeEach(() => {
  store.clear();
  storage.save.mockClear();
  storage.fileFn.mockClear();
  fetchSpy.mockClear();
  store.setDoc("subscriptions", USER, { plan: "smart" }); // upload_file needs the fileUpload feature
});

describe("upload_file refuses URLs that point inside", () => {
  it.each([
    "http://example.com/a.pdf",
    "https://localhost/a.pdf",
    "https://127.0.0.1/a.pdf",
    "https://fibuki-api:8788/__data/query",
    "https://postgres/a.pdf",
    "https://seaweedfs:8333/bucket/key",
    "https://10.0.0.5/a.pdf",
    "https://172.17.0.1/a.pdf",
    "https://169.254.169.254/latest/meta-data/",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://[::1]/a.pdf",
    "https://[::ffff:10.0.0.1]/a.pdf",
    "https://2130706433/a.pdf",
    "https://example.com:8443/a.pdf",
    "https://user:pw@example.com/a.pdf",
    "file:///etc/passwd",
  ])("%s", async (url) => {
    await expect(upload({ url })).rejects.toThrow(/URL not allowed/);
    // Nothing was written anywhere.
    expect(storage.save).not.toHaveBeenCalled();
    expect(store.getCollection("files").size).toBe(0);
  });

  it("says what to do instead", async () => {
    await expect(upload({ url: "https://10.0.0.5/a.pdf" })).rejects.toThrow(/send the file as base64/);
  });

  it("a url that is not a string is refused rather than coerced", async () => {
    await expect(upload({ url: { href: "https://example.com" } })).rejects.toThrow(/url must be a string/);
    await expect(upload({ url: ["https://example.com/a.pdf"] })).rejects.toThrow(/url must be a string/);
  });
});

describe("upload_file with a public URL", () => {
  it("downloads it and stores the file, as before", async () => {
    fetchSpy.mockResolvedValueOnce({ buffer: Buffer.from("%PDF-1.4 invoice"), contentType: "application/pdf", finalUrl: "https://files.example.com/a.pdf" });
    const result = await upload({ url: "https://files.example.com/a.pdf" });

    expect(fetchSpy).toHaveBeenCalledWith("https://files.example.com/a.pdf");
    expect(result).toMatchObject({ success: true, duplicate: false, fileSize: 16 });
    expect(storage.save).toHaveBeenCalledTimes(1);
    expect(store.getCollection("files").size).toBe(1);
  });

  it("a download that fails (not found, too large, timeout) is reported, and stores nothing", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("File is larger than the 25 MB limit"));
    await expect(upload({ url: "https://files.example.com/huge.pdf" })).rejects.toThrow(/larger than the 25 MB limit/);
    expect(storage.save).not.toHaveBeenCalled();
  });

  it("base64 uploads are untouched and never go near the network", async () => {
    const result = await upload({ base64: Buffer.from("%PDF-1.4 other").toString("base64") });
    expect(result).toMatchObject({ success: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the tool definition", () => {
  it("tells callers which URLs are accepted", () => {
    const def = TOOL_DEFINITIONS.find((t) => t.name === "upload_file")!;
    const url = (def.inputSchema.properties as Record<string, { description: string }>).url;
    expect(url.description).toMatch(/Public https/);
    expect(url.description).toMatch(/refused/);
  });
});
