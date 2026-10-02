/**
 * MCP endpoint (Streamable HTTP)
 *
 * Implements the Model Context Protocol for remote clients: ChatGPT, Codex,
 * Claude (Desktop, web, API connector) and any other MCP client.
 *
 * Endpoint: POST https://fibuki.com/api/mcp/sse (Next proxy) -> mcpSse
 * Auth: Bearer token (fk_ API key)
 *
 * The name `mcpSse` is historical and kept so the Next proxy, the self-host
 * route table and existing client configs keep working. The protocol work
 * lives in mcp-server.ts; this file is the HTTP edge: CORS, auth, and the
 * Express <-> fetch Request/Response bridge.
 */

import { onRequest } from "firebase-functions/v2/https";
import { validateApiKey } from "../api-keys";
import { handleMcpRequest, MCP_SERVER_NAME, MCP_SERVER_VERSION } from "./mcp-server";
import { bearerChallenge } from "../oauth/oauthCore";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
};


const STREAMABLE_ACCEPT = "application/json, text/event-stream";

interface HttpRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: Buffer;
}

interface HttpResponse {
  set(headers: Record<string, string>): unknown;
  setHeader(name: string, value: string): unknown;
  status(code: number): HttpResponse;
  json(body: unknown): unknown;
  send(body: string): unknown;
  end(): unknown;
}

/**
 * Every 401 says where the OAuth metadata is (RFC 9728), so a client that has no token yet
 * discovers how to get one, and one whose token expired knows to refresh it.
 */
function unauthorized(res: HttpResponse, message: string, invalidToken = false): void {
  res.setHeader("WWW-Authenticate", bearerChallenge(invalidToken ? "invalid_token" : undefined));
  res.status(401).json({ jsonrpc: "2.0", id: null, error: { code: -32001, message } });
}

/**
 * Express request -> fetch Request for the SDK transport.
 *
 * Clients written before Streamable HTTP (and our own proxy, until it forwarded
 * Accept) send no Accept header or only application/json. The transport would
 * answer those with 406, so the edge fills in what the spec asks for; the
 * response is JSON either way.
 */
export function toFetchRequest(req: HttpRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }

  const accept = headers.get("accept") ?? "";
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
    headers.set("accept", STREAMABLE_ACCEPT);
  }
  if (req.method === "POST" && !headers.get("content-type")?.includes("application/json")) {
    headers.set("content-type", "application/json");
  }
  // The body is re-serialised below, so the original length no longer applies.
  headers.delete("content-length");

  // The host's body parser already read the JSON, and handleMcpRequest hands
  // that to the transport as parsedBody. Only re-attach bytes when nothing was
  // parsed, so a large upload_file payload is not copied a second time.
  const body =
    req.method === "POST" && req.body === undefined && req.rawBody?.length
      ? req.rawBody.toString("utf8")
      : undefined;

  return new Request("http://fibuki-mcp.local/mcp", { method: req.method, headers, body });
}

async function sendFetchResponse(res: HttpResponse, response: Response): Promise<void> {
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() !== "content-length") res.setHeader(name, value);
  });
  const text = await response.text();
  res.status(response.status);
  if (text) res.send(text);
  else res.end();
}

export const mcpSse = onRequest(
  {
    region: "europe-west1",
    memory: "512MiB",
    timeoutSeconds: 300,
  },
  async (req, res) => {
    const request = req as unknown as HttpRequest;
    const response = res as unknown as HttpResponse;

    response.set(CORS_HEADERS);

    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }

    const authHeader = request.headers.authorization;
    const authValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (!authValue?.startsWith("Bearer ")) {
      unauthorized(response, "Missing Authorization header");
      return;
    }

    const validated = await validateApiKey(authValue.substring(7));
    if (!validated) {
      unauthorized(response, "Invalid or expired token", true);
      return;
    }

    if (request.method === "GET") {
      const accept = request.headers.accept;
      const wantsStream = (Array.isArray(accept) ? accept.join(",") : accept ?? "").includes(
        "text/event-stream"
      );
      if (wantsStream) {
        // Stateless server: no server-initiated stream. The spec allows 405 here.
        response.setHeader("Allow", "POST");
        response.status(405).json({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "This server does not offer a GET event stream; use POST" },
        });
        return;
      }
      // Plain GET: a quick authenticated health/info check, as before.
      response.status(200).json({
        name: MCP_SERVER_NAME,
        version: MCP_SERVER_VERSION,
        transport: "streamable-http",
        capabilities: { tools: {} },
      });
      return;
    }

    if (request.method !== "POST") {
      // DELETE ends a session; a stateless server has none.
      response.setHeader("Allow", "POST, GET, OPTIONS");
      response.status(405).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed" } });
      return;
    }

    const mcpResponse = await handleMcpRequest(validated.userId, toFetchRequest(request), request.body);
    await sendFetchResponse(response, mcpResponse);
  }
);
