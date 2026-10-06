/**
 * Which Mail Integrations the receipt search reads (#746).
 *
 * One rule for every caller: the search queue, the Import trigger, the timed
 * search, the header scan and the chat assistant's mail tools. A Mail
 * Integration is searched when it is active, is not waiting for new
 * credentials, and its Mail Provider is one FiBuKI can open. Which provider it
 * is does not matter beyond that.
 *
 * No runtime imports: the chat tools in fibuki-web import this too.
 */

/** The Mail Providers the receipt search can open, Gmail over OAuth and IMAP. */
export const SEARCHABLE_MAIL_PROVIDERS = ["gmail", "imap"] as const;

/** Mail Integrations one search reads at most, counted over every provider. */
export const MAX_SEARCHED_MAIL_INTEGRATIONS = 5;

export interface SearchableMailIntegrationLike {
  /** Missing on Gmail integrations made before IMAP existed. */
  provider?: unknown;
  isActive?: unknown;
  needsReauth?: unknown;
  /** Firestore Timestamp, Date or absent; orders the cap. */
  createdAt?: unknown;
}

/** The integration's Mail Provider, with the pre-IMAP default. */
export function mailProviderOf(integration: object): string {
  const provider = (integration as { provider?: unknown }).provider;
  return typeof provider === "string" && provider ? provider : "gmail";
}

/** Whether the receipt search reads this Mail Integration. */
export function isSearchableMailIntegration(integration: SearchableMailIntegrationLike): boolean {
  return (
    integration.isActive === true &&
    integration.needsReauth !== true &&
    (SEARCHABLE_MAIL_PROVIDERS as readonly string[]).includes(mailProviderOf(integration))
  );
}

function createdMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (value && typeof (value as { toMillis?: unknown }).toMillis === "function") {
    return (value as { toMillis: () => number }).toMillis();
  }
  if (value && typeof (value as { toDate?: unknown }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().getTime();
  }
  // No date at all sorts first: those are the oldest records, made before
  // the field was written.
  return 0;
}

/**
 * The Mail Integrations one search reads: the searchable ones, oldest first,
 * at most MAX_SEARCHED_MAIL_INTEGRATIONS. Oldest first so the cap picks the
 * same mailboxes on every run, whichever provider each one is.
 */
export function searchedMailIntegrations<T extends SearchableMailIntegrationLike & { id: string }>(
  integrations: readonly T[]
): T[] {
  return integrations
    .filter(isSearchableMailIntegration)
    .slice()
    .sort((a, b) => createdMillis(a.createdAt) - createdMillis(b.createdAt) || a.id.localeCompare(b.id))
    .slice(0, MAX_SEARCHED_MAIL_INTEGRATIONS);
}
