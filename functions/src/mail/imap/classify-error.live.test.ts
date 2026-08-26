/**
 * LIVE check that a REAL rejected login classifies as `auth_failed` (#178).
 *
 * Skipped by default. This exists because the shim tests that pin the worker's
 * failure path stage the error object by hand — `authenticationFailed`,
 * `serverResponseCode`, `responseText` — and a Firestore double cannot prove
 * that a real IMAP server's rejection carries those fields at all. If it does
 * not, every one of those tests passes while a broken mailbox in production
 * reports `connect_failed` and keeps retrying.
 *
 * Deliberately wrong password, so no real credential is needed or handled: a
 * valid host and username are enough to make a server say no. It drives the
 * real ImapProvider rather than a raw ImapFlow client, because the provider is
 * what the sync worker holds and `search()` is where the connect happens.
 *
 *   IMAP_BADPW_LIVE=1 IMAP_HOST=<host> IMAP_USER=<user> \
 *     npx vitest run src/mail/imap/classify-error.live.test.ts --pool=forks --maxWorkers=1
 *
 * Run it sparingly — a burst of failed logins is exactly what a mail server's
 * brute-force protection is watching for. One attempt per run, no loops.
 */

import { describe, it, expect } from "vitest";
import { ImapProvider } from "./ImapProvider";
import { classifyImapError } from "./classify-error";

const LIVE =
  process.env.IMAP_BADPW_LIVE === "1" && !!process.env.IMAP_HOST && !!process.env.IMAP_USER;

const baseConfig = {
  host: process.env.IMAP_HOST || "",
  port: Number(process.env.IMAP_PORT || "993"),
  secure: true,
  allowSelfSigned: process.env.IMAP_ALLOW_SELF_SIGNED === "true",
  mailbox: process.env.IMAP_MAILBOX || "INBOX",
  keywordPrefilter: false,
  user: process.env.IMAP_USER || "",
  password: "not-the-app-password-and-never-was",
};

/** What the classifier reads. Printed so a future run can see the real shape. */
function shapeOf(error: unknown): Record<string, unknown> {
  const e = (error ?? {}) as Record<string, unknown>;
  return {
    message: error instanceof Error ? error.message : String(error),
    authenticationFailed: e.authenticationFailed,
    serverResponseCode: e.serverResponseCode,
    responseText: e.responseText,
    mailboxMissing: e.mailboxMissing,
    code: e.code,
  };
}

describe.skipIf(!LIVE)("classifyImapError (live server)", () => {
  it("classifies a real rejected login as auth_failed", async () => {
    const provider = new ImapProvider(baseConfig);
    let caught: unknown;
    try {
      await provider.search({ dateFrom: new Date("2026-01-01T00:00:00Z"), dateTo: new Date() });
    } catch (error) {
      caught = error;
    } finally {
      await provider.close();
    }

    expect(caught, "the server accepted a wrong password — check the config").toBeDefined();
    console.log("[live] rejected-login error shape:", shapeOf(caught));

    expect(classifyImapError(caught).code).toBe("auth_failed");
  });

  it("classifies an unresolvable host as unreachable", async () => {
    const provider = new ImapProvider({
      ...baseConfig,
      host: "no-such-host.invalid",
    });
    let caught: unknown;
    try {
      await provider.search({ dateFrom: new Date("2026-01-01T00:00:00Z"), dateTo: new Date() });
    } catch (error) {
      caught = error;
    } finally {
      await provider.close();
    }

    expect(caught).toBeDefined();
    console.log("[live] unreachable error shape:", shapeOf(caught));

    expect(classifyImapError(caught).code).toBe("unreachable");
  });
});
