/**
 * MCP proxy (Streamable HTTP)
 *
 * https://fibuki.com/api/mcp/sse -> mcpSse on fibuki-api / Cloud Functions.
 * Used by ChatGPT, Codex, Claude and any other remote MCP client.
 *
 * The proxy is transparent: it forwards the MCP headers and passes the
 * upstream status, headers and body through untouched. Notifications are
 * answered with 202 and an empty body, so the body is never parsed here.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveFunctionsUrl, FUNCTIONS_URL_UNSET_ERROR } from "@/lib/api/functions-origin";

const CF_URL = resolveFunctionsUrl("mcpSse");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
};

/** Request headers the MCP transport reads. */
const FORWARD_REQUEST_HEADERS = [
  "authorization",
  "content-type",
  "accept",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
];

/** Response headers a client needs back. */
const FORWARD_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "www-authenticate", "allow"];

async function proxy(request: NextRequest): Promise<NextResponse> {
  if (!CF_URL) {
    return NextResponse.json({ error: FUNCTIONS_URL_UNSET_ERROR }, { status: 500 });
  }

  if (!request.headers.get("authorization")) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Missing Authorization header" } },
      { status: 401, headers: { ...CORS_HEADERS, "WWW-Authenticate": 'Bearer realm="fibuki"' } }
    );
  }

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  try {
    const upstream = await fetch(CF_URL, {
      method: request.method,
      headers,
      body: request.method === "POST" ? await request.text() : undefined,
    });

    const responseHeaders = new Headers(CORS_HEADERS);
    for (const name of FORWARD_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }

    const body = await upstream.text();
    return new NextResponse(body || null, { status: upstream.status, headers: responseHeaders });
  } catch {
    return NextResponse.json({ error: "Proxy error" }, { status: 502, headers: CORS_HEADERS });
  }
}

export const POST = proxy;
export const GET = proxy;
export const DELETE = proxy;

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
