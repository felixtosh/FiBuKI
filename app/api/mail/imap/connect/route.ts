export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { ImapFlow } from "imapflow";
import { getAdminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { encrypt, getEncryptionKey } from "@/lib/crypto/encryption";
import { startImapInitialSync } from "@/functions/src/gmail/startImapInitialSync";
import { classifyImapError } from "@/functions/src/mail/imap/classify-error";

const db = getAdminDb();
const INTEGRATIONS_COLLECTION = "emailIntegrations";
const TOKENS_COLLECTION = "emailTokens";

/**
 * Whether this build talks to the self-host backend rather than Firebase.
 *
 * next.config.ts bakes NEXT_PUBLIC_FIBUKI_BACKEND in at build time whenever
 * FIBUKI_BACKEND=selfhost, so the public copy is the one that is reliably
 * present in the running web container; FIBUKI_BACKEND itself is only
 * guaranteed during the build. Both are checked so the flag holds either way.
 */
const IS_SELFHOST =
  process.env.NEXT_PUBLIC_FIBUKI_BACKEND === "selfhost" ||
  process.env.FIBUKI_BACKEND === "selfhost";

interface ConnectBody {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  password?: string;
  mailbox?: string;
  allowSelfSigned?: boolean;
  keywordPrefilter?: boolean;
}

/**
 * POST /api/mail/imap/connect
 *
 * Verify an IMAP mailbox with a live login, then persist an `emailIntegrations`
 * document (provider "imap") plus the AES-encrypted app-password, then start
 * the initial sync.
 *
 * On Firebase the sync is started by the onMailServiceConnected trigger and the
 * call below is skipped. A self-host deployment gets no such trigger for this
 * write — it happens in the web container, and trigger delivery is in-process in
 * the API container — so the route enqueues it directly. See
 * functions/src/gmail/startImapInitialSync.ts.
 *
 * Body: { host, port?, secure?, user, password, mailbox?, allowSelfSigned?, keywordPrefilter? }
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const body = (await request.json()) as ConnectBody;

    const host = body.host?.trim();
    const user = body.user?.trim();
    const password = body.password;
    const port = body.port ?? 993;
    const secure = body.secure ?? true;
    const mailbox = body.mailbox?.trim() || "INBOX";
    const allowSelfSigned = Boolean(body.allowSelfSigned);
    const keywordPrefilter = body.keywordPrefilter ?? true;

    if (!host || !user || !password) {
      return NextResponse.json(
        { error: "host, user and password are required" },
        { status: 400 }
      );
    }

    // 1. Verify BEFORE persisting: live login + read-only mailbox open.
    const client = new ImapFlow({
      host,
      port,
      secure,
      auth: { user, pass: password },
      logger: false,
      ...(allowSelfSigned ? { tls: { rejectUnauthorized: false } } : {}),
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock(mailbox, { readOnly: true });
      lock.release();
      await client.logout();
    } catch (error) {
      try {
        client.close();
      } catch {
        // ignore — connection may already be down
      }
      const { code, message } = classifyImapError(error);
      console.error(`[IMAP connect] verify failed (${code}):`, error);
      return NextResponse.json({ error: message, code }, { status: 400 });
    }

    const email = user.toLowerCase();

    // 2. Reject a duplicate active integration for the same user + mailbox.
    const existing = await db
      .collection(INTEGRATIONS_COLLECTION)
      .where("userId", "==", userId)
      .where("provider", "==", "imap")
      .where("email", "==", email)
      .where("isActive", "==", true)
      .get();

    const alreadyConnected = existing.docs.find(
      (d) => (d.data().imapMailbox || "INBOX") === mailbox
    );
    if (alreadyConnected) {
      return NextResponse.json(
        { error: "This mailbox is already connected.", code: "already_connected" },
        { status: 409 }
      );
    }

    // 3. Encrypt the app-password. Unlike Gmail we refuse to store it in the
    //    clear — there is no OAuth revocation fallback for a raw password.
    let secret: string;
    let secretIv: string;
    try {
      const key = getEncryptionKey();
      const enc = encrypt(password, key);
      secret = enc.encrypted;
      secretIv = enc.iv;
    } catch (error) {
      console.error("[IMAP connect] encryption unavailable:", error);
      return NextResponse.json(
        { error: "Server is not configured to store credentials securely." },
        { status: 500 }
      );
    }

    // 4. Create the integration (on Firebase this fires onMailServiceConnected).
    const now = Timestamp.now();
    const integrationRef = await db.collection(INTEGRATIONS_COLLECTION).add({
      userId,
      provider: "imap",
      email,
      displayName: user,
      accountId: email,
      isActive: true,
      needsReauth: false,
      lastError: null,
      // Reconnecting a broken mailbox is disconnect-then-connect (the duplicate
      // check refuses a second active row for the same mailbox), so a fixed
      // app-password arrives here as a fresh document. State it rather than
      // leaving the field absent: the row reads "no classified error", not
      // "unknown", the moment the mailbox is connected again.
      lastSyncErrorCode: null,
      // IMAP connection config (read by the sync worker's makeProvider).
      imapHost: host,
      imapPort: port,
      imapSecure: secure,
      imapAllowSelfSigned: allowSelfSigned,
      imapKeywordPrefilter: keywordPrefilter,
      imapMailbox: mailbox,
      createdAt: now,
      updatedAt: now,
    });

    // 5. Store the encrypted credential alongside the Gmail token collection.
    await db.collection(TOKENS_COLLECTION).doc(integrationRef.id).set({
      integrationId: integrationRef.id,
      userId,
      provider: "imap",
      secret,
      secretIv,
      updatedAt: now,
    });

    // 6. Start the initial sync ourselves when no trigger will do it for us.
    //    Failure here must not fail the connect: the mailbox IS connected and
    //    stored, and a sync can still be started by hand from the sync route.
    if (IS_SELFHOST) {
      try {
        await startImapInitialSync({
          integrationId: integrationRef.id,
          userId,
          email,
        });
      } catch (error) {
        console.error("[IMAP connect] initial sync enqueue failed:", error);
      }
    }

    return NextResponse.json({ success: true, integrationId: integrationRef.id });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[IMAP connect] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to connect mailbox" },
      { status: 500 }
    );
  }
}
