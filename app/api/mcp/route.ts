/**
 * MCP REST API Proxy
 *
 * Proxies requests to Cloud Functions for nice URLs:
 * https://fibuki.com/api/mcp → Cloud Functions mcpApi
 */

import { NextRequest, NextResponse } from "next/server";

const CF_URL = "https://europe-west1-taxstudio-f12fb.cloudfunctions.net/mcpApi";

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");

  if (!authHeader) {
    return NextResponse.json(
      { success: false, error: "Missing Authorization header" },
      { status: 401 }
    );
  }

  try {
    const body = await request.json();

    const response = await fetch(CF_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": authHeader,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: "Proxy error" },
      { status: 500 }
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
