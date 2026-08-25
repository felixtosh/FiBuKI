export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { encrypt, getEncryptionKey } from "@/lib/crypto/encryption";
import { verifyImapMailbox } from "@/lib/mail/verify-imap-mailbox";

const db = getAdminDb();
const INTEGRATIONS_COLLECTION = "emailIntegrations";
const TOKENS_COLLECTION = "emailTokens";

interface CredentialsBody {
  integrationId?: string;
  password?: string;
  host?: string;
  port?: number;
  secure?: boolean;
  mailbox?: string;
  allowSelfSigned?: boolean;
}

/**
 * PATCH /api/mail/imap/credentials
 *
 * Repair a connected IMAP mailbox in place: verify a new app-password with a
 * live login, then store it and clear the failure state.
 *
 * Why this exists. A rejected IMAP login sets `needsReauth`, and everything
 * that syncs mail then skips the mailbox: the nightly job filters the flag out
 * and the manual sync route answers 403. Only a successful sync clears it, and
 * no sync can be attempted — so before this route the flag was a state the
 * mailbox could not leave. The escape was disconnect-then-connect, which
 * soft-deletes every file from that mailbox not yet matched to a transaction:
 * a mistyped app-password cost the user their unmatched receipts.
 *
 * What it deliberately does NOT do:
 *
 *   - Change the username or address. That is a different mailbox, and it
 *     stays disconnect-then-connect so the identity of an integration does not
 *     silently change underneath its files.
 *   - Enqueue a sync. Clearing the flag returns the mailbox to the nightly
 *     job's query, and Pull New Files covers the impatient case. Enqueueing
 *     here would give the repair path its own sync semantics to reason about,
 *     parallel to startImapInitialSync.
 *   - Resume queue items. An IMAP auth failure is classified fatal, so the
 *     worker fails the item outright rather than pausing it — unlike Gmail,
 *     whose paused items the reconnection trigger resumes.
 *
 * Body: { integrationId, password, host?, port?, secure?, mailbox?, allowSelfSigned? }
 */
export async function PATCH(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const body = (await request.json()) as CredentialsBody;

    const integrationId = body.integrationId?.trim();
    const password = body.password;

    if (!integrationId || !password) {
      return NextResponse.json(
        { error: "integrationId and password are required" },
        { status: 400 }
      );
    }

    // 1. Resolve the mailbox and confirm it is the caller's. A mailbox
    //    belonging to someone else is reported as absent, matching the other
    //    integration routes: ownership is not a fact to leak.
    const integrationRef = db.collection(INTEGRATIONS_COLLECTION).doc(integrationId);
    const integrationSnap = await integrationRef.get();
    const integration = integrationSnap.exists ? integrationSnap.data()! : null;

    // A disconnected mailbox is not repairable: its files are already
    // soft-deleted and its tokens removed, so storing a credential against it
    // would resurrect half of something the user chose to remove. Reconnecting
    // one is the connect route's job.
    if (!integration || integration.userId !== userId || integration.isActive !== true) {
      return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
    }

    if (integration.provider !== "imap") {
      return NextResponse.json(
        {
          error: "This integration does not use an app-password. Reconnect it through its own provider.",
          code: "wrong_provider",
        },
        { status: 400 }
      );
    }

    // 2. Effective connection settings: what the caller supplied, else what the
    //    mailbox already stores. A repair usually changes only the password, so
    //    an omitted field must mean "keep", never "reset to default".
    const host = body.host?.trim() || (integration.imapHost as string | undefined);
    const port = body.port ?? (integration.imapPort as number | undefined) ?? 993;
    const secure = body.secure ?? (integration.imapSecure as boolean | undefined) ?? true;
    const mailbox =
      body.mailbox?.trim() || (integration.imapMailbox as string | undefined) || "INBOX";
    const allowSelfSigned =
      body.allowSelfSigned ?? (integration.imapAllowSelfSigned as boolean | undefined) ?? false;
    const user = (integration.displayName as string | undefined) || (integration.email as string);

    if (!host || !user) {
      return NextResponse.json(
        { error: "This mailbox is missing its connection settings. Reconnect it instead." },
        { status: 400 }
      );
    }

    // 3. Verify BEFORE persisting, exactly as the connect route does. A failed
    //    attempt must leave the mailbox precisely as it was — a user checking a
    //    guess at their password cannot be allowed to make things worse.
    const failure = await verifyImapMailbox({
      host,
      port,
      secure,
      user,
      password,
      mailbox,
      allowSelfSigned,
    });
    if (failure) {
      console.error(`[IMAP credentials] verify failed (${failure.code})`);
      return NextResponse.json(
        { error: failure.message, code: failure.code },
        { status: 400 }
      );
    }

    // 4. Encrypt the new app-password. As at connect: we refuse to store it in
    //    the clear, because there is no revocation fallback for a raw password.
    let secret: string;
    let secretIv: string;
    try {
      const key = getEncryptionKey();
      const enc = encrypt(password, key);
      secret = enc.encrypted;
      secretIv = enc.iv;
    } catch (error) {
      console.error("[IMAP credentials] encryption unavailable:", error);
      return NextResponse.json(
        { error: "Server is not configured to store credentials securely." },
        { status: 500 }
      );
    }

    const now = Timestamp.now();

    // 5. Store the credential first. If the flag-clearing update below fails,
    //    the mailbox is left with a working password and a stale error, which
    //    the next successful sync clears. The reverse order would leave a
    //    mailbox marked healthy while still holding the password that failed.
    await db.collection(TOKENS_COLLECTION).doc(integrationId).set({
      integrationId,
      userId,
      provider: "imap",
      secret,
      secretIv,
      updatedAt: now,
    });

    // 6. Apply any changed settings and clear the failure state. The mailbox
    //    re-enters the nightly job's query on this write.
    await integrationRef.update({
      imapHost: host,
      imapPort: port,
      imapSecure: secure,
      imapMailbox: mailbox,
      imapAllowSelfSigned: allowSelfSigned,
      needsReauth: false,
      lastSyncErrorCode: null,
      lastError: null,
      lastSyncError: null,
      updatedAt: now,
    });

    return NextResponse.json({ success: true, integrationId });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[IMAP credentials] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update credentials" },
      { status: 500 }
    );
  }
}
