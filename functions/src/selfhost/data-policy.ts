/**
 * Client data-plane access policy — machine-readable mirror of
 * firestore.rules (repo root), enforced server-side by data-plane.ts.
 * Sibling of manifest.ts: additive, loud on anything unlisted.
 *
 * Access levels:
 *   owner   row-scoped: data.userId === auth.uid (queries get the owner
 *           filter INJECTED server-side — the rules trusted the client to
 *           add where("userId","==",uid) on list; we don't)
 *   uidKey  doc id === auth.uid (subscriptions/{uid})
 *   authed  any authenticated user
 *   admin   auth token carries admin: true
 *   none    denied for the client (Cloud-Functions-only in the rules)
 *
 * The users/{uid}/... subtree is handled separately (SUBTREE_POLICIES):
 * path uid must equal auth.uid, then the first subcollection name decides.
 * Collections of excluded modules (billing/expand/referral/MFA) are simply
 * unlisted -> denied.
 */

export type Access = "owner" | "uidKey" | "authed" | "admin" | "none";

export interface CollectionPolicy {
  read: Access;
  create: Access;
  update: Access;
  delete: Access;
}

const ownerCrud: CollectionPolicy = { read: "owner", create: "owner", update: "owner", delete: "owner" };
const ownerReadOnly: CollectionPolicy = { read: "owner", create: "none", update: "none", delete: "none" };
const adminOnly: CollectionPolicy = { read: "admin", create: "admin", update: "admin", delete: "admin" };
const denied: CollectionPolicy = { read: "none", create: "none", update: "none", delete: "none" };

export const TOP_LEVEL_POLICIES: Readonly<Record<string, CollectionPolicy>> = {
  sources: ownerCrud,
  transactions: ownerCrud,
  files: ownerCrud,
  partners: ownerCrud,
  emailIntegrations: ownerCrud,
  imports: ownerCrud,
  noReceiptCategories: ownerCrud,
  fileConnections: ownerCrud,
  inboundEmailAddresses: ownerCrud,
  agentSearchSessions: ownerCrud,

  aiUsage: { read: "owner", create: "owner", update: "none", delete: "none" },
  precisionSearchQueue: { read: "owner", create: "owner", update: "none", delete: "none" },

  invoices: ownerReadOnly,
  functionCalls: ownerReadOnly,
  gmailSyncQueue: ownerReadOnly,
  gmailSyncHistory: ownerReadOnly,
  inboundEmailLogs: ownerReadOnly,
  userExports: ownerReadOnly,
  userImports: ownerReadOnly,
  bmdExports: ownerReadOnly,
  apiKeys: ownerReadOnly,
  mfaAuditLogs: ownerReadOnly,

  subscriptions: { read: "uidKey", create: "none", update: "none", delete: "none" },
  config: { read: "authed", create: "none", update: "none", delete: "none" },
  globalPartners: { read: "authed", create: "admin", update: "admin", delete: "admin" },

  allowedEmails: adminOnly,
  promotionCandidates: adminOnly,
  accessRequests: { read: "admin", create: "none", update: "none", delete: "none" },

  // Explicitly denied (rules: allow read, write: if false) — listed so a
  // future edit consciously flips them instead of "fixing" a 403.
  emailTokens: denied,
  invoiceShares: denied,
};

/**
 * transactions/{id}/history is the only client-visible subcollection outside
 * users/: readable/creatable when authenticated (rules), entries immutable.
 */
export const TRANSACTION_HISTORY_POLICY: CollectionPolicy = {
  read: "authed",
  create: "authed",
  update: "none",
  delete: "none",
};

/** users/{uid}/<name>/... — uid must equal auth.uid, then this table. */
export const SUBTREE_POLICIES: Readonly<Record<string, CollectionPolicy>> = {
  settings: { read: "authed", create: "authed", update: "authed", delete: "authed" },
  notifications: { read: "authed", create: "authed", update: "authed", delete: "authed" },
  chatSessions: { read: "authed", create: "authed", update: "authed", delete: "authed" },
  reports: { read: "authed", create: "authed", update: "authed", delete: "authed" },
  passkeyChallenge: { read: "authed", create: "authed", update: "authed", delete: "authed" },
  workerRequests: { read: "authed", create: "authed", update: "authed", delete: "authed" },
  mfaSettings: { read: "authed", create: "authed", update: "authed", delete: "authed" },
  workerRuns: { read: "authed", create: "none", update: "none", delete: "none" },
  passkeys: { read: "authed", create: "none", update: "none", delete: "none" },
  backupCodes: denied,
  system: denied, // learningQueue etc. — server-only
};

/** The users/{uid} document itself: read/write when uid matches. */
export const USER_DOC_POLICY: CollectionPolicy = {
  read: "authed",
  create: "authed",
  update: "authed",
  delete: "none",
};
