/**
 * consumeSocialAccessRequest (lib/auth/social-access-request.ts): the shared
 * login / register hook that turns a self-host social-error return into the
 * "access request submitted" banner. Pure URL-marker logic — no auth client
 * involved — so a hand-rolled window is enough.
 */

import { describe, it, expect, afterEach } from "vitest";
import { consumeSocialAccessRequest } from "../../../lib/auth/social-access-request";

function installWindow(search: string): string[] {
  const replaced: string[] = [];
  (globalThis as Record<string, unknown>).window = {
    location: { pathname: "/login", search },
    history: {
      replaceState: (_data: unknown, _unused: string, url?: string) => {
        if (typeof url === "string") replaced.push(url);
      },
    },
  };
  return replaced;
}

describe("consumeSocialAccessRequest", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
  });

  it("detects the marker, returns true once, and strips it", () => {
    const replaced = installWindow("?fibuki_social_error=access_denied");
    expect(consumeSocialAccessRequest()).toBe(true);
    expect(replaced).toEqual(["/login"]); // clean URL, no query
  });

  it("returns false and leaves the URL untouched when the marker is absent", () => {
    const replaced = installWindow("?ref=abc");
    expect(consumeSocialAccessRequest()).toBe(false);
    expect(replaced).toHaveLength(0);
  });

  it("preserves other query params when stripping the marker", () => {
    const replaced = installWindow("?fibuki_social_error=access_denied&ref=xyz");
    expect(consumeSocialAccessRequest()).toBe(true);
    expect(replaced).toEqual(["/login?ref=xyz"]);
  });

  it("also strips Better Auth's appended error / error_description", () => {
    // redirectOnError tacks these onto our errorCallbackURL; the banner already
    // conveys the outcome, so they shouldn't linger in the URL bar.
    const replaced = installWindow(
      "?fibuki_social_error=access_denied&error=access_denied&error_description=blocked&ref=xyz",
    );
    expect(consumeSocialAccessRequest()).toBe(true);
    expect(replaced).toEqual(["/login?ref=xyz"]);
  });

  it("is a no-op during SSR (no window)", () => {
    expect(consumeSocialAccessRequest()).toBe(false);
  });
});
