/**
 * The HTTP edge of the MCP endpoint: auth challenge, methods, and the
 * Express <-> fetch bridge. Protocol behaviour is in mcp-server.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api-keys", () => ({ validateApiKey: vi.fn() }));
vi.mock("./handlers", () => ({ handleToolInternal: vi.fn() }));

import { validateApiKey } from "../api-keys";
import { mcpSse } from "./mcp-sse";

const validate = vi.mocked(validateApiKey);

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  set(h: Record<string, string>): FakeRes;
  setHeader(n: string, v: string): FakeRes;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
  send(b: string): FakeRes;
  end(): FakeRes;
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    headers: {},
    body: "",
    set(h) {
      for (const [k, v] of Object.entries(h)) res.headers[k.toLowerCase()] = v;
      return res;
    },
    setHeader(n, v) {
      res.headers[n.toLowerCase()] = v;
      return res;
    },
    status(c) {
      res.statusCode = c;
      return res;
    },
    json(b) {
      res.body = JSON.stringify(b);
      return res;
    },
    send(b) {
      res.body = b;
      return res;
    },
    end() {
      return res;
    },
  };
  return res;
}

async function call(method: string, headers: Record<string, string>, body?: unknown) {
  const res = fakeRes();
  await (mcpSse as unknown as (req: unknown, res: unknown) => Promise<void>)(
    { method, headers, body },
    res
  );
  return res;
}

const AUTH = { authorization: "Bearer fk_test" };

beforeEach(() => {
  validate.mockReset();
  validate.mockResolvedValue({ userId: "user-1" } as Awaited<ReturnType<typeof validateApiKey>>);
});

describe("auth", () => {
  it("challenges a request without a key", async () => {
    const res = await call("POST", {}, {});
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toMatch(/^Bearer /);
  });

  it("challenges an invalid key", async () => {
    validate.mockResolvedValue(null);
    const res = await call("POST", AUTH, {});
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toMatch(/^Bearer /);
  });
});

describe("methods", () => {
  it("answers a JSON-RPC initialize from an old client that sends no Accept header", async () => {
    const res = await call("POST", { ...AUTH, "content-type": "application/json" }, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "old", version: "0" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(res.body).result.protocolVersion).toBe("2024-11-05");
  });

  it("refuses a GET event stream with 405, as the spec allows for a stateless server", async () => {
    const res = await call("GET", { ...AUTH, accept: "text/event-stream" });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("POST");
  });

  it("keeps the plain GET info response", async () => {
    const res = await call("GET", AUTH);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).name).toBe("FiBuKI");
  });

  it("refuses DELETE: there is no session to end", async () => {
    const res = await call("DELETE", AUTH);
    expect(res.statusCode).toBe(405);
  });

  it("answers CORS preflight without auth", async () => {
    const res = await call("OPTIONS", {});
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-headers"]).toContain("MCP-Protocol-Version");
    expect(validate).not.toHaveBeenCalled();
  });
});

describe("a real MCP client over HTTP", () => {
  it("connects, lists tools and calls one through Express", async () => {
    const express = (await import("express")).default;
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const { handleToolInternal } = await import("./handlers");
    vi.mocked(handleToolInternal).mockResolvedValue({ sources: [] });

    const app = express();
    app.all("/mcp", express.json(), (req, res) => mcpSse(req as never, res as never));
    const server = await new Promise<import("http").Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const { port } = server.address() as import("net").AddressInfo;

    const client = new Client({ name: "test-client", version: "1.0.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
          requestInit: { headers: { Authorization: "Bearer fk_test" } },
        })
      );
      expect(client.getServerVersion()?.name).toBe("FiBuKI");
      expect(client.getInstructions()).toContain("cents");

      const { tools } = await client.listTools();
      expect(tools.find((t) => t.name === "list_sources")?.annotations?.readOnlyHint).toBe(true);

      const result = await client.callTool({ name: "list_sources", arguments: {} });
      expect(result.structuredContent).toEqual({ sources: [] });
    } finally {
      await client.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
