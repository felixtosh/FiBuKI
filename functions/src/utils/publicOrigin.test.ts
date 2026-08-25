import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { publicOrigin } from "./publicOrigin";
import { buildUnsubscribeUrl } from "../emails/unsubscribeTokens";

const saved = {
  pub: process.env.FIBUKI_PUBLIC_URL,
  app: process.env.NEXT_PUBLIC_APP_URL,
};

beforeEach(() => {
  delete process.env.FIBUKI_PUBLIC_URL;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

afterAll(() => {
  if (saved.pub === undefined) delete process.env.FIBUKI_PUBLIC_URL;
  else process.env.FIBUKI_PUBLIC_URL = saved.pub;
  if (saved.app === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = saved.app;
});

describe("publicOrigin", () => {
  it("trims a trailing slash", () => {
    process.env.FIBUKI_PUBLIC_URL = "https://fibuki.test/";
    expect(publicOrigin()).toBe("https://fibuki.test");
  });

  it("falls back to the app URL", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.fibuki.test";
    expect(publicOrigin()).toBe("https://app.fibuki.test");
  });

  it("is null when nothing is configured — no address is invented", () => {
    expect(publicOrigin()).toBeNull();
  });
});

describe("buildUnsubscribeUrl", () => {
  it("points at this deployment, never at Cloud Functions", () => {
    process.env.FIBUKI_PUBLIC_URL = "https://fibuki.test";
    const url = buildUnsubscribeUrl("user-1", "digest");
    expect(url).toContain("https://fibuki.test/unsubscribeDigest?uid=user-1");
    expect(url).not.toContain("cloudfunctions.net");
  });

  it("refuses rather than emitting a link to somebody else's backend", () => {
    expect(() => buildUnsubscribeUrl("user-1", "digest")).toThrow(/FIBUKI_PUBLIC_URL/);
  });
});
