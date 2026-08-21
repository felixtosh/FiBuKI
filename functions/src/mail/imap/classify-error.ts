/**
 * Classify an IMAP failure into one of five outcomes the UI can act on.
 *
 * Lives here rather than in the connect route because two callers need the same
 * vocabulary: the connect route answers a failed verify login with the code, and
 * the sync worker persists it on the integration when a background sync fails.
 * One mailbox, two moments, one set of words.
 *
 * Direction of the dependency matters: the app layer imports from `functions/`,
 * never the reverse — `functions/` builds standalone for deploy.
 */

/** The five outcomes. `connect_failed` is the fallback, carrying the raw text. */
export type ImapErrorCode =
  | "auth_failed"
  | "tls_failed"
  | "unreachable"
  | "mailbox_not_found"
  | "connect_failed";

export interface ImapErrorClassification {
  code: ImapErrorCode;
  /** User-facing copy. Deliberately not pinned by tests. */
  message: string;
}

/**
 * IMAP failures that cannot resolve without the user reconnecting — the sync
 * worker fails these on the first attempt instead of retrying, and the
 * mailbox row disables its Pull New Files button for them.
 */
export const FATAL_IMAP_ERROR_CODES: ReadonlySet<ImapErrorCode> = new Set([
  "auth_failed",
  "mailbox_not_found",
]);

/**
 * Fixed per-code copy for rendering a persisted `lastSyncErrorCode` on a
 * mailbox row, where (unlike a live connect attempt) no error object survives
 * to pass through `classifyImapError` again.
 *
 * `auth_failed`, `tls_failed` and `unreachable` never carry live detail below
 * — `classifyImapError` returns exactly this text for them too, sourced from
 * here so the two can't drift. `mailbox_not_found` is the *common* case for
 * that code (imapflow sets `mailboxMissing` whenever the server rejects the
 * folder by name, which is how a wrong folder name actually shows up); the
 * rarer regex-fallback path inside `classifyImapError` uses a shorter generic
 * form instead, since by the time that branch is reached there is no
 * `mailboxMissing` flag to confirm the folder-name framing applies.
 * `connect_failed` is the fallback for whatever text the server/library sent,
 * which is never persisted, so the row falls back to a generic phrase.
 */
export const IMAP_ERROR_MESSAGES: Record<ImapErrorCode, string> = {
  auth_failed: "Authentication failed. Check the username and app-password.",
  tls_failed: "TLS/certificate error. For an internal server, enable 'allow self-signed'.",
  unreachable: "Could not reach the mail server. Check host and port.",
  mailbox_not_found:
    "Mailbox not found on the server. Use the folder name, e.g. INBOX, not the email address.",
  connect_failed: "Could not connect to the mail server.",
};

/**
 * Classify an imapflow connection failure so the UI can be specific about
 * whether the host, the TLS cert, or the credentials are wrong.
 */
export function classifyImapError(error: unknown): ImapErrorClassification {
  // imapflow reports a server NO/BAD as the bare message "Command failed" and
  // puts the useful part on the error object (responseText, serverResponseCode,
  // mailboxMissing). Fold those in so the regexes below see the real reason and
  // the fallback surfaces the server's own words instead of "Command failed".
  const e = (error ?? {}) as {
    responseText?: string;
    serverResponseCode?: string;
    mailboxMissing?: boolean;
    authenticationFailed?: boolean;
  };
  const base = error instanceof Error ? error.message : String(error);
  const msg = [base, e.serverResponseCode, e.responseText].filter(Boolean).join(" ");
  const authCode = e.authenticationFailed;
  if (e.mailboxMissing) {
    const detail = e.responseText ? ` (${e.responseText})` : "";
    return {
      code: "mailbox_not_found",
      message: `Mailbox not found on the server${detail}. Use the folder name, e.g. INBOX, not the email address.`,
    };
  }
  if (authCode || /AUTHENTICATIONFAILED|invalid credentials|auth/i.test(msg)) {
    return { code: "auth_failed", message: IMAP_ERROR_MESSAGES.auth_failed };
  }
  if (/self.signed|certificate|SSL|TLS|DEPTH_ZERO/i.test(msg)) {
    return { code: "tls_failed", message: IMAP_ERROR_MESSAGES.tls_failed };
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|getaddrinfo/i.test(msg)) {
    return { code: "unreachable", message: IMAP_ERROR_MESSAGES.unreachable };
  }
  if (/Mailbox|NONEXISTENT|does not exist/i.test(msg)) {
    return { code: "mailbox_not_found", message: "Mailbox not found on the server." };
  }
  return { code: "connect_failed", message: msg };
}
