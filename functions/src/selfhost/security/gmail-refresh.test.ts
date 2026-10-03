/**
 * The Gmail token refresh route (#44): a refreshed token that Google issued
 * without `gmail.readonly` is refused and the integration stays flagged for
 * reconnection. The sync queue and the search callable already refuse it on
 * their own refresh; this route used to store the token and clear the flag.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { __resetFirestoreShim, getFirestore } from "../firestore-shim";
import { asUser, enableInternalAuth } from "./routes";

const OWNER = "owner-1";
const INTEGRATION = "mail-1";
const GMAIL = "https://www.googleapis.com/auth/gmail.readonly";
const USERINFO = "https://www.googleapis.com/auth/userinfo.email openid";

beforeAll(() => {
  enableInternalAuth();
  process.env.GOOGLE_CLIENT_ID = "client-id";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
});

beforeEach(async () => {
  await __resetFirestoreShim();
  const db = getFirestore();
  await db.collection("emailIntegrations").doc(INTEGRATION).set({
    userId: OWNER,
    email: "me@gmail.test",
    needsReauth: true,
    lastError: "Gmail search failed: 403 insufficientPermissions",
  });
  await db.collection("emailTokens").doc(INTEGRATION).set({
    userId: OWNER,
    accessToken: "old-access",
    refreshToken: "RT",
  });
});
afterEach(() => vi.unstubAllGlobals());

function stubRefresh(scope: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600, token_type: "Bearer", scope }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
  );
}

async function refresh() {
  const { POST } = await import("@/app/api/gmail/refresh/route");
  return POST(asUser(OWNER, "/api/gmail/refresh", { body: { integrationId: INTEGRATION } }));
}

const stored = async () => {
  const db = getFirestore();
  return {
    integration: (await db.collection("emailIntegrations").doc(INTEGRATION).get()).data()!,
    token: (await db.collection("emailTokens").doc(INTEGRATION).get()).data()!,
  };
};

describe("POST /api/gmail/refresh", () => {
  it("refuses a refreshed token without gmail.readonly and keeps the integration flagged", async () => {
    stubRefresh(USERINFO);
    const res = await refresh();
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("new-access");

    const { integration, token } = await stored();
    expect(integration.needsReauth).toBe(true);
    expect(integration.lastError).toContain("Gmail access not granted");
    expect(token.accessToken).toBe("old-access");
  });

  it("stores a refreshed token that carries gmail.readonly and clears the flag", async () => {
    stubRefresh(`${GMAIL} ${USERINFO}`);
    const res = await refresh();
    expect(res.status).toBe(200);

    const { integration, token } = await stored();
    expect(integration.needsReauth).toBe(false);
    expect(token.accessToken).toBe("new-access");
  });
});
