/**
 * Calling a Next API route handler as a given user, in-process.
 *
 * Routes learn the caller from getServerUserIdWithFallback, which accepts the
 * shared internal secret plus an asserted uid. That path is trusted on
 * purpose (server-to-server calls), so it is the cheapest honest way for a
 * test to say "this request comes from the attacker" without minting tokens.
 */

import { NextRequest } from "next/server";

const SECRET = "selfhost-security-suite-secret-0123456789";

export function enableInternalAuth(): void {
  process.env.INTERNAL_API_SECRET = SECRET;
}

export function asUser(
  uid: string,
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): NextRequest {
  const headers: Record<string, string> = {
    "X-Internal-Secret": SECRET,
    "X-Internal-User-Id": uid,
    ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...init.headers,
  };
  return new NextRequest(new URL(url, "https://web.test"), {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

/** A request with no identity at all. */
export function anonymous(url: string, body?: unknown): NextRequest {
  return new NextRequest(new URL(url, "https://web.test"), {
    method: body !== undefined ? "POST" : "GET",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** The response body as text (JSON or not), for leak checks. */
export async function bodyText(res: Response): Promise<string> {
  return res.text();
}
