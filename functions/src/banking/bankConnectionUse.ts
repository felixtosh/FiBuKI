/**
 * Whether a provider's bank connection is still used by a Bank Account (#815).
 *
 * One connection can back several Bank Accounts: a TrueLayer connection is
 * linked to each account the User picked from it (`apiConfig.connectionId`,
 * the id of its `truelayerConnections` document), and a finAPI bank
 * connection holds every account at that bank (`apiConfig.bankConnectionId`).
 * A path that removes a connection (the Bank Account delete, the bank
 * disconnect, the orphan cleanup) removes it only when none of the User's
 * other Bank Accounts names it.
 *
 * The callables and the Next routes both decide through this module, so it
 * imports nothing that reaches `createCallable` or `firebase-functions`
 * (browser-imports.test.ts rule 2).
 */

/** The provider connection a Bank Account syncs through. */
export type BankConnection =
  | { provider: "truelayer"; connectionId: string }
  | { provider: "finapi"; bankConnectionId: string };

/**
 * The connection a Bank Account's `apiConfig` names, or null. A finAPI id is
 * compared as text: it is stored as a number or as a string, depending on the
 * path that linked the account.
 */
export function bankConnectionOf(source: FirebaseFirestore.DocumentData | undefined): BankConnection | null {
  const apiConfig = source?.apiConfig as { provider?: unknown; connectionId?: unknown; bankConnectionId?: unknown } | undefined;
  if (!apiConfig) return null;
  if (apiConfig.provider === "truelayer" && typeof apiConfig.connectionId === "string" && apiConfig.connectionId) {
    return { provider: "truelayer", connectionId: apiConfig.connectionId };
  }
  const bankConnectionId = apiConfig.bankConnectionId;
  if (
    apiConfig.provider === "finapi" &&
    (typeof bankConnectionId === "number" || typeof bankConnectionId === "string") &&
    String(bankConnectionId) !== ""
  ) {
    return { provider: "finapi", bankConnectionId: String(bankConnectionId) };
  }
  return null;
}

function sameConnection(a: BankConnection | null, b: BankConnection): boolean {
  if (!a || a.provider !== b.provider) return false;
  return a.provider === "truelayer"
    ? a.connectionId === (b as { connectionId: string }).connectionId
    : a.bankConnectionId === (b as { bankConnectionId: string }).bankConnectionId;
}

/** A Bank Account as read: its id and its stored data. */
type StoredSource = { id: string; data(): FirebaseFirestore.DocumentData | undefined };

/**
 * Whether one of `sources`, other than `exceptSourceId`, names the
 * connection. For a caller that has already read the User's Bank Accounts
 * (all of them, by `userId`) and checks several connections against them.
 */
export function isBankConnectionUsedBy(
  sources: readonly StoredSource[],
  connection: BankConnection,
  exceptSourceId?: string
): boolean {
  return sources.some((doc) => doc.id !== exceptSourceId && sameConnection(bankConnectionOf(doc.data()), connection));
}

/** The User's Bank Accounts, every `type`, read once for `isBankConnectionUsedBy`. */
export async function readUserSources(db: FirebaseFirestore.Firestore, userId: string): Promise<StoredSource[]> {
  return (await db.collection("sources").where("userId", "==", userId).get()).docs;
}

/**
 * Whether one of the User's Bank Accounts, other than `exceptSourceId`, still
 * names the connection. Only the User's own Bank Accounts count. A Bank
 * Account counts whatever its `type` says while its `apiConfig` names the
 * connection: keeping a connection too long costs an orphan the cleanup
 * sweeps, removing one in use costs the User a new bank login.
 */
export async function isBankConnectionStillUsed(
  db: FirebaseFirestore.Firestore,
  userId: string,
  connection: BankConnection,
  exceptSourceId?: string
): Promise<boolean> {
  return isBankConnectionUsedBy(await readUserSources(db, userId), connection, exceptSourceId);
}

/**
 * The User's own stored TrueLayer connection, or null. A Bank Account's
 * `apiConfig.connectionId` is the User's to write, so it can name another
 * User's connection (one tenant, many Users): a path that deletes the
 * connection a Bank Account names deletes only one whose `userId` is the
 * caller's.
 */
export async function ownTrueLayerConnection(
  db: FirebaseFirestore.Firestore,
  userId: string,
  connectionId: string
): Promise<FirebaseFirestore.DocumentReference | null> {
  const ref = db.collection("truelayerConnections").doc(connectionId);
  const snap = await ref.get();
  return snap.exists && snap.data()?.userId === userId ? ref : null;
}
