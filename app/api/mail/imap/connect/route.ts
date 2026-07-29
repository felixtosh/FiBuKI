export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { ImapFlow } from "imapflow";
import { getAdminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { encrypt, getEncryptionKey } from "@/lib/crypto/encryption";

const db = getAdminDb();
const INTEGRATIONS_COLLECTION = "emailIntegrations";
const TOKENS_COLLECTION = "emailTokens";

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
 * Classify an imapflow connection failure so the UI can be specific about
 * whether the host, the TLS cert, or the credentials are wrong.
 */
function classifyImapError(error: unknown): { code: string; message: string } {
  const msg = error instanceof Error ? error.message : String(error);
  const authCode = (error as { authenticationFailed?: boolean })?.authenticationFailed;
  if (authCode || /AUTHENTICATIONFAILED|invalid credentials|auth/i.test(msg)) {
    return { code: "auth_failed", message: "Authentication failed. Check the username and app-password." };
  }
  if (/self.signed|certificate|SSL|TLS|DEPTH_ZERO/i.test(msg)) {
    return { code: "tls_failed", message: "TLS/certificate error. For an internal server, enable 'allow self-signed'." };
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|getaddrinfo/i.test(msg)) {
    return { code: "unreachable", message: "Could not reach the mail server. Check host and port." };
  }
  if (/Mailbox|NONEXISTENT|does not exist/i.test(msg)) {
    return { code: "mailbox_not_found", message: "Mailbox not found on the server." };
  }
  return { code: "connect_failed", message: msg };
}

/**
 * POST /api/mail/imap/connect
 *
 * Verify an IMAP mailbox with a live login, then persist an `emailIntegrations`
 * document (provider "imap") plus the AES-encrypted app-password. The
 * onMailServiceConnected trigger enqueues the initial sync.
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

    // 4. Create the integration (triggers onMailServiceConnected → initial sync).
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
