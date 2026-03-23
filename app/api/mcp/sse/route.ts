/**
 * MCP SSE Proxy (for Anthropic Claude MCP Connect)
 *
 * Proxies MCP protocol requests:
 * https://fibuki.com/api/mcp/sse → Cloud Functions mcpSse
 */

import { NextRequest, NextResponse } from "next/server";

const CF_URL = process.env.NEXT_PUBLIC_FUNCTIONS_URL ? `${process.env.NEXT_PUBLIC_FUNCTIONS_URL}/mcpSse` : `https://europe-west1-${process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "taxstudio-f12fb"}.cloudfunctions.net/mcpSse`;

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");

  if (!authHeader) {
    return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
  }

  try {
    const body = await request.json();

    const response = await fetch(CF_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    return NextResponse.json({ error: "Proxy error" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");

  if (!authHeader) {
    return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
  }

  try {
    const response = await fetch(CF_URL, {
      method: "GET",
      headers: {
        Authorization: authHeader,
      },
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    return NextResponse.json({ error: "Proxy error" }, { status: 500 });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
