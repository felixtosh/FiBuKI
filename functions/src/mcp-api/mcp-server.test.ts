/**
 * The MCP endpoint speaks current Streamable HTTP (2025-11-25) and still
 * answers clients that negotiate 2024-11-05, which is all the old hand-rolled
 * server spoke. Tools are unchanged; only their MCP envelope is new.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./handlers", () => ({ handleToolInternal: vi.fn() }));

import { handleToolInternal } from "./handlers";
import { handleMcpRequest, MCP_INSTRUCTIONS } from "./mcp-server";
import { toFetchRequest } from "./mcp-sse";
import { TOOL_NAMES } from "../tools/definitions";
import { DESTRUCTIVE_TOOLS, READ_ONLY_TOOLS, WRITE_TOOLS } from "./tool-annotations";

const handleTool = vi.mocked(handleToolInternal);
const USER = "user-1";
const ACCEPT = "application/json, text/event-stream";

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const request = new Request("http://test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: ACCEPT, ...headers },
  });
  return handleMcpRequest(USER, request, body);
}

function rpc(method: string, params: Record<string, unknown> = {}, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

function initialize(protocolVersion: string) {
  return rpc("initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
}

beforeEach(() => {
  handleTool.mockReset();
});

describe("initialize", () => {
  it("negotiates the current protocol and sends instructions", async () => {
    const res = await post(initialize("2025-11-25"));
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull(); // stateless
    const { result } = await res.json();
    expect(result.protocolVersion).toBe("2025-11-25");
    expect(result.serverInfo.name).toBe("FiBuKI");
    expect(result.capabilities.tools).toBeDefined();
    expect(result.instructions).toBe(MCP_INSTRUCTIONS);
  });

  it("still answers a 2024-11-05 client", async () => {
    const { result } = await (await post(initialize("2024-11-05"))).json();
    expect(result.protocolVersion).toBe("2024-11-05");
  });

  it("keeps the rules that protect the books inside the first 512 characters", () => {
    const head = MCP_INSTRUCTIONS.slice(0, 512);
    expect(head).toContain("cents");
    expect(head).toContain("never be deleted");
    expect(head).toContain("never score yourself");
  });
});

describe("notifications", () => {
  it("accepts notifications/initialized with 202 and no body (the old server errored)", async () => {
    const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });
});

describe("tools/list", () => {
  it("lists every tool with annotations and no non-standard top-level fields", async () => {
    const { result } = await (await post(rpc("tools/list"))).json();
    expect(result.tools.map((t: { name: string }) => t.name)).toEqual(TOOL_NAMES);

    for (const tool of result.tools) {
      expect(tool.title).toBeTruthy();
      expect(typeof tool.annotations.readOnlyHint).toBe("boolean");
      expect(typeof tool.annotations.destructiveHint).toBe("boolean");
      expect(tool).not.toHaveProperty("requiredFeature");
    }

    const byName = Object.fromEntries(result.tools.map((t: { name: string }) => [t.name, t]));
    expect(byName.list_transactions.annotations.readOnlyHint).toBe(true);
    expect(byName.delete_source.annotations.destructiveHint).toBe(true);
    expect(byName.delete_file.annotations.destructiveHint).toBe(false); // reversible, ADR-0006
    expect(byName.upload_file._meta).toEqual({ "fibuki/requiredFeature": "fileUpload" });
  });
});

describe("tools/call", () => {
  it("returns structuredContent next to the text block", async () => {
    handleTool.mockResolvedValue({ sources: [{ id: "s1" }] });
    const { result } = await (
      await post(rpc("tools/call", { name: "list_sources", arguments: {} }))
    ).json();

    expect(handleTool).toHaveBeenCalledWith(USER, "list_sources", {});
    expect(result.structuredContent).toEqual({ sources: [{ id: "s1" }] });
    expect(JSON.parse(result.content[0].text)).toEqual({ sources: [{ id: "s1" }] });
    expect(result.isError).toBeUndefined();
  });

  it("wraps a non-object result so structuredContent stays an object", async () => {
    handleTool.mockResolvedValue([1, 2]);
    const { result } = await (
      await post(rpc("tools/call", { name: "list_partners", arguments: {} }))
    ).json();
    expect(result.structuredContent).toEqual({ result: [1, 2] });
  });

  it("reports a tool failure as isError so the model can recover", async () => {
    handleTool.mockImplementation(async () => {
      throw new Error("This tool requires the fileUpload feature");
    });
    const { result, error } = await (
      await post(rpc("tools/call", { name: "upload_file", arguments: { fileName: "a.pdf" } }))
    ).json();
    expect(error).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("fileUpload");
  });

  it("rejects an unknown tool as a protocol error without running anything", async () => {
    const { error } = await (await post(rpc("tools/call", { name: "delete_transaction" }))).json();
    expect(error.code).toBe(-32602);
    expect(handleTool).not.toHaveBeenCalled();
  });
});

describe("annotation lists", () => {
  it("classify every tool exactly once", () => {
    const all = [...READ_ONLY_TOOLS, ...WRITE_TOOLS, ...DESTRUCTIVE_TOOLS] as string[];
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...TOOL_NAMES].sort());
  });
});

describe("toFetchRequest", () => {
  it("fills in the Streamable HTTP Accept header for clients that send none", async () => {
    const request = toFetchRequest({
      method: "POST",
      headers: { authorization: "Bearer fk_x", "content-length": "12" },
      body: initialize("2024-11-05"),
    });
    expect(request.headers.get("accept")).toBe(ACCEPT);
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("content-length")).toBeNull();

    const res = await handleMcpRequest(USER, request, initialize("2024-11-05"));
    expect(res.status).toBe(200);
  });

  it("keeps a complete Accept header as sent", () => {
    const request = toFetchRequest({ method: "POST", headers: { accept: ACCEPT }, body: {} });
    expect(request.headers.get("accept")).toBe(ACCEPT);
  });
});
