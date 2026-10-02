import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { oauthPreflight, proxyOAuth } from "@/lib/api/oauth-proxy";

const fetchMock = vi.fn();

beforeEach(() => {
  process.env.NEXT_PUBLIC_FUNCTIONS_URL = "http://fibuki-api:8788/";
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  delete process.env.NEXT_PUBLIC_FUNCTIONS_URL;
});

const upstream = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "application/json" }, ...init });

describe("proxyOAuth", () => {
  it("forwards a form-encoded token request as it came, with its content type", async () => {
    fetchMock.mockResolvedValue(upstream('{"access_token":"fk_x"}', { headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache" } }));
    const form = "grant_type=authorization_code&code=abc&client_id=oc_1&code_verifier=v";
    const res = await proxyOAuth(
      new NextRequest("https://fibuki.com/api/oauth/token", { method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded" } }),
      "oauthToken"
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://fibuki-api:8788/oauthToken");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(form);
    expect(init.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe('{"access_token":"fk_x"}');
  });

  it("passes the caller's address on (first forwarded entry only) so the backend can rate-limit it, and passes Retry-After back", async () => {
    fetchMock.mockResolvedValue(upstream('{"error":"temporarily_unavailable"}', { status: 429, headers: { "content-type": "application/json", "retry-after": "120" } }));
    const res = await proxyOAuth(
      new NextRequest("https://fibuki.com/api/oauth/register", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7, 10.0.0.2" },
      }),
      "oauthRegister"
    );
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.7" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("120");
  });

  it("passes a GET's query through and adds the document the route stands for", async () => {
    fetchMock.mockResolvedValue(upstream("{}"));
    await proxyOAuth(new NextRequest("https://fibuki.com/oauth?client_id=oc_1&state=a%2Fb"), "oauthMetadata", { doc: "protected-resource" });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/oauthMetadata");
    expect(url.searchParams.get("client_id")).toBe("oc_1");
    expect(url.searchParams.get("state")).toBe("a/b");
    expect(url.searchParams.get("doc")).toBe("protected-resource");
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });

  it("a client cannot choose the document through the query", async () => {
    fetchMock.mockResolvedValue(upstream("{}"));
    await proxyOAuth(new NextRequest("https://fibuki.com/x?doc=authorization-server"), "oauthMetadata", { doc: "protected-resource" });
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("doc")).toBe("protected-resource");
  });

  it("passes errors through with their status", async () => {
    fetchMock.mockResolvedValue(upstream('{"error":"invalid_grant"}', { status: 400 }));
    const res = await proxyOAuth(new NextRequest("https://fibuki.com/t", { method: "POST", body: "{}" }), "oauthToken");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_grant" });
  });

  it("answers 502 when the backend is down, and 500 when none is configured", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    expect((await proxyOAuth(new NextRequest("https://fibuki.com/t"), "oauthMetadata")).status).toBe(502);

    delete process.env.NEXT_PUBLIC_FUNCTIONS_URL;
    const res = await proxyOAuth(new NextRequest("https://fibuki.com/t"), "oauthMetadata");
    expect(res.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1); // never guesses a backend
  });
});

describe("oauthPreflight", () => {
  it("allows other origins to call the public endpoints", () => {
    const res = oauthPreflight();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-headers")).toContain("Content-Type");
  });
});
