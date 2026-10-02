/**
 * Forwards OAuth requests from the public origin (https://fibuki.com) to the OAuth
 * functions on fibuki-api. The functions hold all the logic; this only moves bytes, so
 * the issuer, the metadata and the token endpoint all answer on the one origin ChatGPT
 * and Claude were told about.
 */

import { NextRequest, NextResponse } from "next/server";
import { functionsUrl, FUNCTIONS_URL_UNSET_ERROR } from "@/lib/api/functions-origin";

/** Response headers worth passing back from the function. */
const PASS_THROUGH = ["content-type", "cache-control", "pragma", "allow", "retry-after", "access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers"];

export async function proxyOAuth(
  request: NextRequest,
  functionName: string,
  extraQuery: Record<string, string> = {}
): Promise<NextResponse> {
  const base = functionsUrl(functionName);
  if (!base) {
    return NextResponse.json({ error: "server_error", error_description: FUNCTIONS_URL_UNSET_ERROR }, { status: 500 });
  }

  const target = new URL(base);
  request.nextUrl.searchParams.forEach((value, key) => target.searchParams.set(key, value));
  for (const [key, value] of Object.entries(extraQuery)) target.searchParams.set(key, value);

  const hasBody = request.method === "POST";
  // The function sits behind this proxy, so the caller's address is only known here. Caddy replaces any
  // forwarded address a client sent, so the first entry is the real one; the backend rate-limits on it.
  const client = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const outgoing: Record<string, string> = {};
  if (hasBody) outgoing["Content-Type"] = request.headers.get("content-type") ?? "application/json";
  if (client) outgoing["X-Forwarded-For"] = client;
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers: outgoing,
      body: hasBody ? await request.text() : undefined,
      cache: "no-store",
    });

    const headers = new Headers();
    for (const name of PASS_THROUGH) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    const body = await upstream.text();
    return new NextResponse(body || null, { status: upstream.status, headers });
  } catch {
    return NextResponse.json({ error: "server_error", error_description: "OAuth backend unreachable" }, { status: 502 });
  }
}

/** Preflight for the endpoints other origins call (token, register, metadata). */
export function oauthPreflight(): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
    },
  });
}
