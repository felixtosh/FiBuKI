/**
 * The /api/mcp proxies must never fall back to the SaaS production Cloud
 * Functions on a self-host build. That fallback silently forwarded every
 * request — API key included — off-box, and the production answer ("Invalid
 * or expired API key", for keys that only exist in the self-host database)
 * was indistinguishable from a local auth bug.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { resolveFunctionsUrl } from "@/lib/api/functions-origin";

const saved = {
  base: process.env.NEXT_PUBLIC_FUNCTIONS_URL,
  backend: process.env.NEXT_PUBLIC_FIBUKI_BACKEND,
};

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_FUNCTIONS_URL;
  delete process.env.NEXT_PUBLIC_FIBUKI_BACKEND;
});

afterAll(() => {
  if (saved.base !== undefined) process.env.NEXT_PUBLIC_FUNCTIONS_URL = saved.base;
  if (saved.backend !== undefined) process.env.NEXT_PUBLIC_FIBUKI_BACKEND = saved.backend;
});

describe("functionsUrl", () => {
  it("uses the configured origin, trimming a trailing slash", () => {
    process.env.NEXT_PUBLIC_FUNCTIONS_URL = "http://fibuki-api:8788/";
    expect(resolveFunctionsUrl("mcpApi")).toBe("http://fibuki-api:8788/mcpApi");
  });

  it("returns null when no origin is configured — no silent Cloud Functions fallback", () => {
    process.env.NEXT_PUBLIC_FIBUKI_BACKEND = "selfhost";
    expect(resolveFunctionsUrl("mcpApi")).toBeNull();
    expect(resolveFunctionsUrl("mcpSse")).toBeNull();
  });

  it("returns null for a build with no backend flag either — the fallback is gone for everyone", () => {
    delete process.env.NEXT_PUBLIC_FIBUKI_BACKEND;
    expect(resolveFunctionsUrl("mcpApi")).toBeNull();
  });

  it("never composes a cloudfunctions.net address", () => {
    process.env.NEXT_PUBLIC_FUNCTIONS_URL = "https://api.fibuki.test";
    expect(resolveFunctionsUrl("mcpApi")).not.toContain("cloudfunctions.net");
  });
});
