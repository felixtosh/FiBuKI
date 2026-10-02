/**
 * The Gmail OAuth callback learns who connected the mailbox from a record the
 * server wrote at authorize time, never from the browser (a cookie holding the
 * uid let anyone attach their mailbox to any account).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { __resetFirestoreShim, getFirestore } from "../firestore-shim";
import { createOAuthState, consumeOAuthState } from "../../../../lib/gmail/oauth-state";

beforeEach(async () => {
  await __resetFirestoreShim();
});

describe("OAuth state binding", () => {
  it("resolves to the uid that started the flow, exactly once", async () => {
    const state = await createOAuthState("user-a", "gmail");
    expect(await consumeOAuthState(state, "gmail")).toBe("user-a");
    expect(await consumeOAuthState(state, "gmail")).toBeNull(); // replay
  });

  it("refuses a forged, malformed or foreign-provider state", async () => {
    expect(await consumeOAuthState("f".repeat(64), "gmail")).toBeNull();
    expect(await consumeOAuthState("not-hex", "gmail")).toBeNull();
    expect(await consumeOAuthState(null, "gmail")).toBeNull();
    const state = await createOAuthState("user-a", "truelayer");
    expect(await consumeOAuthState(state, "gmail")).toBeNull();
  });

  it("refuses an expired state", async () => {
    const state = await createOAuthState("user-a", "gmail");
    const docs = await getFirestore().collection("oauthStates").get();
    await docs.docs[0].ref.update({ expiresAt: new Date(Date.now() - 1000) });
    expect(await consumeOAuthState(state, "gmail")).toBeNull();
  });

  it("never stores the live state value", async () => {
    const state = await createOAuthState("user-a", "gmail");
    const docs = await getFirestore().collection("oauthStates").get();
    expect(docs.docs[0].id).not.toBe(state);
    expect(JSON.stringify(docs.docs[0].data())).not.toContain(state);
  });
});
