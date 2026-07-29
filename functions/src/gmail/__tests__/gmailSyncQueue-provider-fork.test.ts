/**
 * C2 — characterization coverage over `resolveMailProvider`, the provider fork
 * `processQueueItem` runs before it touches a mailbox (gmailSyncQueue.ts).
 *
 * The fork was extracted verbatim from processQueueItem's L244-307 so its two
 * legs can be pinned in isolation — the self-host IMAP path and the cloud
 * Gmail/OAuth path — before real two-user traffic hits them on the new stack.
 * These tests assert the fork's DECISIONS (which throws fire, which provider is
 * built with which credentials, whether a refresh happens), never a live
 * IMAP/Gmail connection: makeProvider, the crypto, and `fetch` are all stubbed.
 *
 * Runs under the functions profile (vitest.config.ts) — no root node_modules.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Recording doubles for the module-level singletons the file wires at import.
// vi.mock factories are hoisted above the imports, so shared state lives in
// vi.hoisted() to be reachable from both the factories and the assertions.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  const updates: Array<{ collection: string; id: string; data: Record<string, unknown> }> = [];
  const madeProviders: Array<{ provider: string; credentials: unknown }> = [];
  const providerSentinel = { __sentinel: "provider", close: async () => {} };
  const db = {
    collection: (collection: string) => ({
      doc: (id: string) => ({
        update: async (data: Record<string, unknown>) => {
          updates.push({ collection, id, data });
        },
        get: async () => ({ exists: false, data: () => undefined }),
      }),
    }),
  };
  return { updates, madeProviders, providerSentinel, db };
});

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => h.db,
  Timestamp: {
    now: () => ({ toMillis: () => 0, toDate: () => new Date(0) }),
    fromDate: (d: Date) => ({ toMillis: () => d.getTime(), toDate: () => d }),
  },
}));

vi.mock("firebase-admin/storage", () => ({
  getStorage: () => ({ bucket: () => ({}) }),
}));

vi.mock("firebase-functions/params", () => ({
  defineSecret: () => ({ value: () => "" }),
}));

vi.mock("firebase-functions/v2/scheduler", () => ({
  onSchedule: () => () => {},
}));

vi.mock("firebase-functions/v2/firestore", () => ({
  onDocumentCreated: () => () => {},
}));

// The fork's leaf decisions: which provider, with which already-decrypted creds.
vi.mock("../../mail", () => ({
  makeProvider: (provider: string, credentials: unknown) => {
    h.madeProviders.push({ provider, credentials });
    return h.providerSentinel;
  },
}));

// Deterministic, reversible-looking stand-ins so the test reads the plaintext
// the fork feeds the provider without holding a real key.
vi.mock("../../utils/encryption", () => ({
  decrypt: (secret: string) => `decrypted:${secret}`,
  encrypt: (plaintext: string) => ({ encrypted: `enc:${plaintext}`, iv: "iv" }),
}));

import { resolveMailProvider } from "../gmailSyncQueue";

const OPTIONS = {
  clientId: "client-id",
  clientSecret: "client-secret",
  encryptionKey: "encryption-key",
};

/** A Timestamp-shaped expiry the fork can `.toDate()`. */
const expiryAt = (ms: number) => ({ toDate: () => new Date(ms) });

/** Minimal fetch Response double for refreshAccessToken. */
function fetchResponse(body: {
  ok: boolean;
  json?: unknown;
  text?: string;
}) {
  return {
    ok: body.ok,
    json: async () => body.json,
    text: async () => body.text ?? "",
  };
}

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

beforeEach(() => {
  h.updates.length = 0;
  h.madeProviders.length = 0;
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// IMAP leg — self-host mail path, no OAuth
// ---------------------------------------------------------------------------
describe("resolveMailProvider — imap leg", () => {
  const imapIntegration = {
    provider: "imap",
    email: "user@example.com",
    imapHost: "imap.example.com",
    imapPort: 993,
    imapSecure: true,
    imapMailbox: "INBOX",
  };

  it("throws when the stored app-password secret is missing", async () => {
    await expect(
      resolveMailProvider("imap", imapIntegration, { secretIv: "iv" }, "int-1", OPTIONS)
    ).rejects.toThrow("IMAP integration is missing its stored app-password");
  });

  it("throws when the secret IV is missing", async () => {
    await expect(
      resolveMailProvider("imap", imapIntegration, { secret: "s" }, "int-1", OPTIONS)
    ).rejects.toThrow("IMAP integration is missing its stored app-password");
  });

  it("throws when the imap host is missing", async () => {
    await expect(
      resolveMailProvider(
        "imap",
        { ...imapIntegration, imapHost: undefined },
        { secret: "s", secretIv: "iv" },
        "int-1",
        OPTIONS
      )
    ).rejects.toThrow("IMAP integration is missing host or username");
  });

  it("throws when the imap username (email) is missing", async () => {
    await expect(
      resolveMailProvider(
        "imap",
        { ...imapIntegration, email: undefined },
        { secret: "s", secretIv: "iv" },
        "int-1",
        OPTIONS
      )
    ).rejects.toThrow("IMAP integration is missing host or username");
  });

  it("builds an imap provider with the decrypted password and connection config", async () => {
    const provider = await resolveMailProvider(
      "imap",
      imapIntegration,
      { secret: "cipher", secretIv: "iv" },
      "int-1",
      OPTIONS
    );

    expect(provider).toBe(h.providerSentinel);
    expect(h.madeProviders).toEqual([
      {
        provider: "imap",
        credentials: {
          imap: {
            host: "imap.example.com",
            port: 993,
            secure: true,
            allowSelfSigned: false,
            mailbox: "INBOX",
            keywordPrefilter: true,
            user: "user@example.com",
            password: "decrypted:cipher",
          },
        },
      },
    ]);
  });

  it("defaults port/mailbox and honours the self-signed + prefilter flags", async () => {
    await resolveMailProvider(
      "imap",
      {
        provider: "imap",
        email: "user@example.com",
        imapHost: "imap.example.com",
        imapSecure: false,
        imapAllowSelfSigned: true,
        imapKeywordPrefilter: false,
      },
      { secret: "cipher", secretIv: "iv" },
      "int-1",
      OPTIONS
    );

    expect(h.madeProviders[0].credentials).toEqual({
      imap: {
        host: "imap.example.com",
        port: 993,
        secure: false,
        allowSelfSigned: true,
        mailbox: "INBOX",
        keywordPrefilter: false,
        user: "user@example.com",
        password: "decrypted:cipher",
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Gmail / OAuth leg — cloud mail path
// ---------------------------------------------------------------------------
describe("resolveMailProvider — gmail/OAuth leg", () => {
  const gmailToken = (expiresAtMs: number) => ({
    accessToken: "current-token",
    refreshToken: "refresh-token",
    refreshTokenIv: "refresh-iv",
    expiresAt: expiryAt(expiresAtMs),
  });

  it("does not refresh a token that is still valid", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const farFuture = Date.now() + 60 * 60 * 1000; // 1h out, well past the 5-min window
    const provider = await resolveMailProvider(
      "gmail",
      { provider: "gmail" },
      gmailToken(farFuture),
      "int-1",
      OPTIONS
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.updates).toEqual([]);
    expect(provider).toBe(h.providerSentinel);
    expect(h.madeProviders).toEqual([
      { provider: "gmail", credentials: { accessToken: "current-token" } },
    ]);
  });

  it("refreshes an expiring token and builds the provider with the new access token", async () => {
    const fetchMock = vi.fn(async () =>
      fetchResponse({
        ok: true,
        json: { access_token: "new-token", expires_in: 3600, scope: GMAIL_SCOPE },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const almostExpired = Date.now() + 60 * 1000; // 1 min out — inside the 5-min window
    const provider = await resolveMailProvider(
      "gmail",
      { provider: "gmail" },
      gmailToken(almostExpired),
      "int-1",
      OPTIONS
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    // Refresh persists the new token to emailTokens and clears reauth on the integration.
    const collections = h.updates.map((u) => u.collection);
    expect(collections).toContain("emailTokens");
    expect(collections).toContain("emailIntegrations");
    expect(provider).toBe(h.providerSentinel);
    expect(h.madeProviders).toEqual([
      { provider: "gmail", credentials: { accessToken: "new-token" } },
    ]);
  });

  it("marks the integration needsReauth and throws when refresh fails", async () => {
    const fetchMock = vi.fn(async () => fetchResponse({ ok: false, text: "invalid_grant" }));
    vi.stubGlobal("fetch", fetchMock);

    const expired = Date.now() - 60 * 1000;
    await expect(
      resolveMailProvider("gmail", { provider: "gmail" }, gmailToken(expired), "int-1", OPTIONS)
    ).rejects.toThrow("Access token expired and refresh failed - needs re-authentication");

    // No provider gets built on the failure path.
    expect(h.madeProviders).toEqual([]);
    const reauth = h.updates.find(
      (u) => u.collection === "emailIntegrations" && u.data.needsReauth === true
    );
    expect(reauth).toBeTruthy();
    expect(reauth?.data.lastError).toBe("Access token expired and refresh failed");
  });

  it("marks needsReauth when a refreshed token comes back missing gmail.readonly scope", async () => {
    const fetchMock = vi.fn(async () =>
      fetchResponse({
        ok: true,
        // Downgraded grant — Google can strip gmail.readonly once verification lapses.
        json: { access_token: "downgraded", expires_in: 3600, scope: "openid email" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const expired = Date.now() - 60 * 1000;
    await expect(
      resolveMailProvider("gmail", { provider: "gmail" }, gmailToken(expired), "int-1", OPTIONS)
    ).rejects.toThrow("Access token expired and refresh failed - needs re-authentication");

    expect(h.madeProviders).toEqual([]);
    const reauth = h.updates.find(
      (u) => u.collection === "emailIntegrations" && u.data.needsReauth === true
    );
    expect(reauth).toBeTruthy();
  });
});
