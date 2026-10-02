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
  // ECB reference rates (#92): server-side only, and not user data at all.
  fxReferenceRates: denied,
};

/**
 * transactions/{id}/history is the only client-visible subcollection outside
 * users/: readable/creatable when authenticated, entries immutable. The
 * entries carry no userId, so data-plane.ts additionally requires the parent
 * transaction to be the caller's (firestore.rules never did).
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
  // The WebAuthn challenge a passkey signature is verified against. Written
  // only by generatePasskey*Options; a client that could write it could set it
  // to the challenge of an assertion it captured earlier and replay that.
  passkeyChallenge: denied,
  workerRequests: { read: "authed", create: "authed", update: "authed", delete: "authed" },
  // Read by the settings screen; changed only by the MFA callables, which
  // verify the factor first. A client write here would let a signed-in session
  // switch the account's MFA off without ever presenting it.
  mfaSettings: { read: "authed", create: "none", update: "none", delete: "none" },
  workerRuns: { read: "authed", create: "none", update: "none", delete: "none" },
  directionSweeps: { read: "authed", create: "none", update: "none", delete: "none" },
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

/** The admin bit, read the one way the data plane and the change stream both use. */
export function isAdminToken(token: Record<string, unknown> | undefined): boolean {
  return token?.admin === true;
}

/**
 * Who may read one document, derived from the policies above. This is what the
 * realtime change stream routes on, so a write is announced to the browsers
 * that could read it and to nobody else.
 *
 * It must stay a projection of the read rules, never a second set of them:
 * that is why it lives here and reads the same tables. Getting it too wide only
 * costs requests (a tab asks about a document and is told it does not match).
 * Getting it too narrow costs freshness, never correctness: every listen still
 * revalidates in full on the safety-net timer, so a missed frame heals.
 *
 *   users/{uid} and users/{uid}/...   that uid
 *   owner                             the userId before and after the write,
 *                                     so a document changing hands reaches both
 *   uidKey                            the doc id
 *   admin                             admins
 *   authed                            everyone in the tenant
 *   none, unlisted, other subtrees    nobody (no client can read it)
 *   transactions/{id}/history         nobody (owner is the parent, see below)
 */
export type ReadAudience =
  | { kind: "users"; uids: string[] }
  | { kind: "admins" }
  | { kind: "everyone" }
  | { kind: "nobody" };

export function readAudience(
  collectionPath: string,
  id: string,
  versions: ReadonlyArray<Record<string, unknown> | undefined>,
): ReadAudience {
  const segs = collectionPath.split("/");

  if (segs[0] === "users") {
    // users/{uid} itself, or anything below it: the path names the reader.
    const uid = segs.length === 1 ? id : segs[1];
    return { kind: "users", uids: [uid] };
  }
  if (segs.length === 3 && segs[0] === "transactions" && segs[2] === "history") {
    // Readable only by the parent transaction's owner (data-plane.ts), and an
    // entry carries no userId to name them. "Everyone" announced every edit
    // to every user; nobody costs only freshness, and no client listens here.
    return { kind: "nobody" };
  }
  if (segs.length !== 1) return { kind: "nobody" };

  const policy = TOP_LEVEL_POLICIES[segs[0]];
  return policy ? audienceFor(policy.read, id, versions) : { kind: "nobody" };
}

function audienceFor(
  access: Access,
  id: string,
  versions: ReadonlyArray<Record<string, unknown> | undefined>,
): ReadAudience {
  switch (access) {
    case "owner": {
      const uids = [
        ...new Set(
          versions
            .map((v) => v?.userId)
            .filter((u): u is string => typeof u === "string" && u.length > 0),
        ),
      ];
      // No owner on either side: the owner filter hides it from every client.
      return uids.length ? { kind: "users", uids } : { kind: "nobody" };
    }
    case "uidKey":
      return { kind: "users", uids: [id] };
    case "admin":
      return { kind: "admins" };
    case "authed":
      return { kind: "everyone" };
    case "none":
      return { kind: "nobody" };
  }
}
