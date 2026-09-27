/**
 * Which mailboxes the connect overlay's mail tabs read, and how they are named
 * (#245).
 *
 * The tabs used to keep `provider === "gmail"` and nothing else, so a user
 * whose only mailbox is IMAP (the likely setup on a self-host box) was told to
 * "Connect Gmail" with a mailbox already connected. Search goes through the
 * provider factory for every provider (#240); these helpers make the tabs do
 * the same. One tab per concept, not per mailbox: results from every mailbox
 * land in one list, each row naming its mailbox.
 */

/** The Mail Providers the attach path can read today. */
export const ATTACHABLE_MAIL_PROVIDERS = ["gmail", "imap"] as const;

export interface MailboxLike {
  id: string;
  provider: string;
  email?: string | null;
  displayName?: string | null;
  needsReauth?: boolean | null;
}

/** Every connected mailbox the mail tabs can search, whatever its provider. */
export function attachableMailboxes<T extends MailboxLike>(integrations: readonly T[]): T[] {
  return integrations.filter((i) =>
    (ATTACHABLE_MAIL_PROVIDERS as readonly string[]).includes(i.provider)
  );
}

/**
 * What the mail tabs can do right now: nothing connected, connected but every
 * mailbox needs re-authentication, or ready. The first two get different empty
 * states, because they need different fixes.
 */
export type MailTabState = "none" | "reauth" | "ready";

export function mailTabState(mailboxes: readonly MailboxLike[]): MailTabState {
  if (mailboxes.length === 0) return "none";
  if (mailboxes.every((m) => m.needsReauth)) return "reauth";
  return "ready";
}

/** The name a row's mailbox chip shows. */
export function mailboxLabel(mailbox: MailboxLike | undefined): string {
  return mailbox?.displayName || mailbox?.email || "Mailbox";
}

/** "Gmail" only where a Gmail integration is meant. */
export function mailProviderLabel(provider: string | undefined): string {
  switch (provider) {
    case "gmail":
      return "Gmail";
    case "imap":
      return "IMAP";
    default:
      return "Mail";
  }
}

/** The mailbox filter only exists once there is more than one mailbox to pick. */
export function showMailboxFilter(mailboxes: readonly MailboxLike[]): boolean {
  return mailboxes.length > 1;
}

/** Narrow results to one mailbox; null or "all" keeps every mailbox. */
export function filterByMailbox<T extends { integrationId: string }>(
  items: readonly T[],
  mailboxId: string | null
): T[] {
  if (!mailboxId || mailboxId === "all") return [...items];
  return items.filter((item) => item.integrationId === mailboxId);
}
