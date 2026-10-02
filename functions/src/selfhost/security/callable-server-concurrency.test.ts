/**
 * Server-side Cloud Function calls carry the token of the request that made
 * them, even when two users' requests are in flight at once.
 *
 * lib/firebase/callable-server.ts used to keep "the current request's token"
 * in a module variable: a route set it, awaited, then called. Two requests
 * interleaving in one process meant the first one's call went out with the
 * second one's token, so one user's arguments ran as the other user.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { asUser, enableInternalAuth } from "./routes";
import { ATTACKER, VICTIM, A, V } from "./victim";

const sent: Array<{ auth: string | null; body: string }> = [];

beforeAll(() => {
  enableInternalAuth();
  process.env.NEXT_PUBLIC_FUNCTIONS_URL = "http://fibuki-api.test";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      // Slow enough that both requests are in flight before either call lands.
      await new Promise((r) => setTimeout(r, 20));
      const headers = new Headers(init.headers);
      sent.push({ auth: headers.get("Authorization"), body: String(init.body) });
      return new Response(JSON.stringify({ result: { success: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_FUNCTIONS_URL;
});

describe("callable-server under concurrency", () => {
  it("each request's call carries its own token", async () => {
    const { POST } = await import("@/app/api/banking/sync/route");
    const req = (uid: string, token: string, sourceId: string) =>
      asUser(uid, "/api/banking/sync", {
        body: { sourceId },
        headers: { Authorization: `Bearer ${token}` },
      });
    const rounds = 5;
    await Promise.all(
      Array.from({ length: rounds }, () => [
        POST(req(ATTACKER, "token-attacker", A.source)),
        POST(req(VICTIM, "token-victim", V.source)),
      ]).flat(),
    );
    expect(sent).toHaveLength(rounds * 2);
    for (const call of sent) {
      const expected = call.body.includes(A.source) ? "Bearer token-attacker" : "Bearer token-victim";
      expect(call.auth, call.body).toBe(expected);
    }
  });
});
