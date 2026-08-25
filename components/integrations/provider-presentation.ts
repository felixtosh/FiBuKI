import type { EmailProvider } from "@/types/email-integration";

/**
 * Everything the per-integration detail page renders *about* a provider.
 *
 * The page is reached by integration id and serves every provider, so each of
 * these was previously a Gmail literal inlined at its call site — which is how
 * an IMAP mailbox came to be described as a Gmail account. Deriving them here
 * means a provider is described in one place, and the exhaustive Record below
 * means a new provider cannot ship silently wearing Gmail's copy.
 */
export interface ProviderPresentation {
  /** Provider name for a label position, e.g. the Connection Details row. */
  name: string;
  /** Heading subtitle prefix, followed by "· Connected <when>". */
  subtitleLabel: string;
  /** Title of the disconnect confirmation dialog. */
  disconnectTitle: string;
  /** Avatar background classes, matching this provider's card in settings. */
  avatarBg: string;
  /** Avatar foreground (icon) classes. */
  avatarFg: string;
  /**
   * How a user restores access after a failure.
   *
   * `oauth` re-runs the provider's consent flow; `credentials` re-enters an
   * app-password. Offering the wrong one is worse than offering none: an
   * OAuth redirect for an IMAP mailbox sends the user to a provider that does
   * not host it.
   */
  reconnectKind: "oauth" | "credentials";
  /** Whether Connection Details shows the IMAP server, port, and folder. */
  showsImapServerDetails: boolean;
}

const PRESENTATION: Record<EmailProvider, ProviderPresentation> = {
  gmail: {
    name: "Gmail",
    subtitleLabel: "Gmail Integration",
    disconnectTitle: "Disconnect Gmail Account?",
    avatarBg: "bg-red-100 dark:bg-red-900/40",
    avatarFg: "text-red-600 dark:text-red-400",
    reconnectKind: "oauth",
    showsImapServerDetails: false,
  },
  imap: {
    name: "IMAP mailbox",
    subtitleLabel: "IMAP Mailbox",
    disconnectTitle: "Disconnect this mailbox?",
    avatarBg: "bg-teal-100 dark:bg-teal-900/40",
    avatarFg: "text-teal-600 dark:text-teal-400",
    reconnectKind: "credentials",
    showsImapServerDetails: true,
  },
  // Outlook and iCloud have no connect flow yet. Their entries exist because
  // the Record is exhaustive over EmailProvider: adding a provider is a type
  // error until it says how it should be described.
  outlook: {
    name: "Outlook",
    subtitleLabel: "Outlook Integration",
    disconnectTitle: "Disconnect Outlook Account?",
    avatarBg: "bg-blue-100 dark:bg-blue-900/40",
    avatarFg: "text-blue-600 dark:text-blue-400",
    reconnectKind: "oauth",
    showsImapServerDetails: false,
  },
  icloud: {
    name: "iCloud",
    subtitleLabel: "iCloud Integration",
    disconnectTitle: "Disconnect iCloud Account?",
    avatarBg: "bg-slate-100 dark:bg-slate-800/60",
    avatarFg: "text-slate-600 dark:text-slate-400",
    reconnectKind: "credentials",
    showsImapServerDetails: false,
  },
};

/**
 * Describe a provider. Falls back to the IMAP description for a stored value
 * outside the union — a mailbox the app cannot name is still closer to a
 * generic mailbox than to a Gmail account.
 */
export function getProviderPresentation(provider: EmailProvider): ProviderPresentation {
  return PRESENTATION[provider] ?? PRESENTATION.imap;
}
