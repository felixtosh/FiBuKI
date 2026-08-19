/**
 * The Anthropic base-URL override (#47).
 *
 * A gateway deployment redirects the origin; everything else about the request
 * shape is unchanged, so the only thing worth pinning is how the URL is built.
 */
import { describe, it, expect, afterEach } from "vitest";
import { anthropicEndpoint } from "./anthropic";

const VARS = ["FIBUKI_ANTHROPIC_BASE_URL", "ANTHROPIC_BASE_URL"] as const;

afterEach(() => {
  for (const v of VARS) delete process.env[v];
});

describe("anthropicEndpoint", () => {
  it("defaults to the public API", () => {
    expect(anthropicEndpoint()).toBe("https://api.anthropic.com/v1/messages");
  });

  it("honours ANTHROPIC_BASE_URL", () => {
    process.env.ANTHROPIC_BASE_URL = "http://gateway:4000";
    expect(anthropicEndpoint()).toBe("http://gateway:4000/v1/messages");
  });

  it("prefers the FIBUKI_-prefixed variable", () => {
    process.env.ANTHROPIC_BASE_URL = "http://other:4000";
    process.env.FIBUKI_ANTHROPIC_BASE_URL = "http://gateway:4000";
    expect(anthropicEndpoint()).toBe("http://gateway:4000/v1/messages");
  });

  it("does not double the separator on a trailing slash", () => {
    process.env.FIBUKI_ANTHROPIC_BASE_URL = "http://gateway:4000///";
    expect(anthropicEndpoint()).toBe("http://gateway:4000/v1/messages");
  });

  it("keeps a path prefix, which is how gateways route per-tenant", () => {
    process.env.FIBUKI_ANTHROPIC_BASE_URL = "https://gw.example.com/anthropic";
    expect(anthropicEndpoint()).toBe(
      "https://gw.example.com/anthropic/v1/messages",
    );
  });

  it("ignores a blank value rather than building a relative URL", () => {
    process.env.FIBUKI_ANTHROPIC_BASE_URL = "   ";
    expect(anthropicEndpoint()).toBe("https://api.anthropic.com/v1/messages");
  });
});
