/**
 * Cross-user isolation fixtures: a victim account with data everywhere, and an
 * attacker account with just enough of its own to get past "not found".
 *
 * Every user on a deployment shares one database tenant, so what separates two
 * accounts is the application's ownership checks and nothing else. These
 * fixtures let a test throw every entry point at the victim's ids and then
 * prove two things:
 *
 *  - nothing the attacker got back contains the victim's CANARY, which is
 *    planted in every readable field of every victim document, and
 *  - every row the victim owns is byte-identical afterwards, and no row was
 *    created in the victim's name, and the victim's stored file still exists.
 */

import { getFirestore, Timestamp, __rawSqlForTest } from "../firestore-shim";
import { getStorage } from "../storage-shim";
import { FLATTENED } from "../db/collections";

export const VICTIM = "victim-7c1d9e";
export const ATTACKER = "attacker-3b8a51";
/** Planted in the victim's data; must never reach the attacker. */
export const CANARY = "CANARY-9f27b4e1";

export const V = {
  source: "v-src-1",
  transaction: "v-tx-1",
  file: "v-file-1",
  partner: "v-partner-1",
  category: "v-cat-1",
  import: "v-import-1",
  integration: "v-mail-1",
  invoice: "v-invoice-1",
  connection: "v-fc-1",
  chat: "v-chat-1",
  notification: "v-note-1",
  apiKey: "v-key-1",
  storagePath: `files/${VICTIM}/v-file-1.pdf`,
};

export const A = {
  source: "a-src-1",
  transaction: "a-tx-1",
  file: "a-file-1",
  partner: "a-partner-1",
  category: "a-cat-1",
  import: "a-import-1",
  integration: "a-mail-1",
  invoice: "a-invoice-1",
  connection: "a-fc-1",
  chat: "a-chat-1",
  notification: "a-note-1",
  apiKey: "a-key-1",
  storagePath: `files/${ATTACKER}/a-file-1.pdf`,
};

export async function seedAccounts(): Promise<void> {
  const db = getFirestore();
  const now = Timestamp.now();
  const owned = { userId: VICTIM, createdAt: now, updatedAt: now };

  await db.doc(`users/${VICTIM}`).set({ email: `${CANARY}@victim.test`, displayName: CANARY });
  await db.doc(`users/${VICTIM}/settings/userData`).set({ companyName: CANARY, vatId: CANARY });
  await db.doc(`users/${VICTIM}/chatSessions/${V.chat}`).set({ title: CANARY, createdAt: now });
  await db.doc(`users/${VICTIM}/notifications/${V.notification}`).set({ message: CANARY, read: false });
  await db.doc(`subscriptions/${VICTIM}`).set({ plan: "pro", stripeCustomerId: CANARY });

  await db.doc(`sources/${V.source}`).set({ ...owned, name: CANARY, iban: "AT611904300234573201", type: "manual", isActive: true });
  await db.doc(`transactions/${V.transaction}`).set({
    ...owned,
    sourceId: V.source,
    name: CANARY,
    partner: CANARY,
    description: CANARY,
    amount: -4242,
    currency: "EUR",
    date: now,
    fileIds: [V.file],
    partnerId: V.partner,
    partnerType: "user",
    isComplete: true,
  });
  await db.doc(`files/${V.file}`).set({
    ...owned,
    fileName: `${CANARY}.pdf`,
    storagePath: V.storagePath,
    downloadUrl: `https://files.test/${CANARY}`,
    extractedText: CANARY,
    extractedPartner: CANARY,
    extractedAmount: 4242,
    transactionIds: [V.transaction],
    uploadedAt: now,
    extractionComplete: true,
  });
  // Subcollections that carry no userId: only the parent says whose they are.
  await db.doc(`transactions/${V.transaction}/history/v-hist-1`).set({
    changedAt: now,
    changedBy: VICTIM,
    previousValues: { description: CANARY },
    newValues: { description: CANARY },
  });
  await db.doc(`transactions/${V.transaction}/searches/v-search-1`).set({ triggeredBy: CANARY, status: "completed", createdAt: now });
  await db.doc(`partners/${V.partner}`).set({ ...owned, name: CANARY, aliases: [CANARY], isActive: true });
  await db.doc(`noReceiptCategories/${V.category}`).set({ ...owned, name: CANARY, templateId: "bank-fees", isActive: true });
  await db.doc(`imports/${V.import}`).set({ ...owned, fileName: CANARY, sourceId: V.source });
  await db.doc(`emailIntegrations/${V.integration}`).set({ ...owned, email: `${CANARY}@mail.test`, isActive: true, provider: "gmail" });
  await db.doc(`invoices/${V.invoice}`).set({ ...owned, number: CANARY, recipientName: CANARY, status: "draft" });
  await db.doc(`fileConnections/${V.connection}`).set({ ...owned, fileId: V.file, transactionId: V.transaction, note: CANARY });
  await db.doc(`apiKeys/${V.apiKey}`).set({ ...owned, name: CANARY, keyHash: CANARY });
  await getStorage().bucket().file(V.storagePath).save(Buffer.from(`%PDF ${CANARY}`));

  // The attacker's own minimal account, so handlers get past "not found" on
  // their own side and actually reach the code that resolves the victim's ids.
  const mine = { userId: ATTACKER, createdAt: now, updatedAt: now };
  await db.doc(`users/${ATTACKER}`).set({ email: "attacker@attacker.test" });
  await db.doc(`sources/${A.source}`).set({ ...mine, name: "Mine", iban: "AT483200000012345864", type: "manual", isActive: true });
  await db.doc(`transactions/${A.transaction}`).set({ ...mine, sourceId: A.source, name: "Mine", amount: -100, currency: "EUR", date: now, fileIds: [] });
  await db.doc(`files/${A.file}`).set({ ...mine, fileName: "mine.pdf", transactionIds: [], uploadedAt: now });
  await db.doc(`partners/${A.partner}`).set({ ...mine, name: "Mine", isActive: true });
  await db.doc(`users/${ATTACKER}/chatSessions/${A.chat}`).set({ title: "Mine", createdAt: now });
  await db.doc(`users/${ATTACKER}/notifications/${A.notification}`).set({ message: "Mine", read: false });
  await db.doc(`noReceiptCategories/${A.category}`).set({ ...mine, name: "Mine", templateId: "bank-fees", isActive: true });
  await db.doc(`imports/${A.import}`).set({ ...mine, fileName: "mine.csv", sourceId: A.source });
  await db.doc(`emailIntegrations/${A.integration}`).set({ ...mine, email: "attacker@mail.test", isActive: true, provider: "gmail" });
  await db.doc(`invoices/${A.invoice}`).set({ ...mine, number: "A-1", recipientName: "Mine", status: "draft" });
  await db.doc(`fileConnections/${A.connection}`).set({ ...mine, fileId: A.file, transactionId: A.transaction });
  await db.doc(`apiKeys/${A.apiKey}`).set({ ...mine, name: "Mine", keyHash: "mine" });
  await getStorage().bucket().file(A.storagePath).save(Buffer.from("%PDF mine"));
}

/** Every row the victim owns, keyed by table and path, as stored JSON text. */
export async function victimRows(): Promise<Map<string, string>> {
  const rows = new Map<string, string>();
  const docs = await __rawSqlForTest(
    `SELECT path, data::text AS data FROM docs
      WHERE data->>'userId' = $1 OR path = $2 OR path LIKE $3 OR path = $4`,
    [VICTIM, `users/${VICTIM}`, `users/${VICTIM}/%`, `subscriptions/${VICTIM}`],
  );
  for (const r of docs.rows) rows.set(`docs:${r.path}`, String(r.data));
  for (const spec of Object.values(FLATTENED)) {
    const flat = await __rawSqlForTest(
      `SELECT id, data::text AS data FROM ${spec.table} WHERE data->>'userId' = $1`,
      [VICTIM],
    );
    for (const r of flat.rows) rows.set(`${spec.table}:${r.id}`, String(r.data));
  }
  // Subcollections under the victim's documents (a Transaction's history and
  // searches) carry no userId; they are the victim's because the parent is.
  const flatCollection = new Map(Object.entries(FLATTENED).map(([coll, spec]) => [spec.table, coll]));
  const parentPaths = [...rows.keys()].map((k) => {
    const [table, ...rest] = k.split(":");
    const key = rest.join(":");
    return table === "docs" ? key : `${flatCollection.get(table)}/${key}`;
  });
  const patterns = parentPaths.map((p) => `${p.replace(/[\\%_]/g, "\\$&")}/%`);
  const subs = await __rawSqlForTest(
    `SELECT path, data::text AS data FROM docs WHERE path LIKE ANY($1::text[])`,
    [patterns],
  );
  for (const r of subs.rows) rows.set(`docs:${r.path}`, String(r.data));
  return rows;
}

/** Throws with a precise list if the victim's account changed in any way. */
export async function assertVictimUntouched(before: Map<string, string>, context: string): Promise<void> {
  const after = await victimRows();
  const problems: string[] = [];
  for (const [key, value] of before) {
    if (!after.has(key)) problems.push(`deleted ${key}`);
    else if (after.get(key) !== value) problems.push(`modified ${key}`);
  }
  for (const key of after.keys()) if (!before.has(key)) problems.push(`created ${key}`);
  const [blob] = await getStorage().bucket().file(V.storagePath).exists();
  if (!blob) problems.push(`deleted storage ${V.storagePath}`);
  if (problems.length) throw new Error(`${context}: victim account changed:\n  ${problems.join("\n  ")}`);
}

/** Throws if anything handed to the attacker carries the victim's data. */
export function assertNoLeak(value: unknown, context: string): void {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, (_k, v) => (v instanceof Error ? { message: v.message, stack: undefined } : v));
  } catch {
    text = String(value);
  }
  if (text && text.includes(CANARY)) {
    throw new Error(`${context}: victim data reached the attacker:\n  ${text.slice(0, 400)}`);
  }
}

/**
 * Argument values that point at the victim, by the shape of the parameter
 * name. Covers every id an entry point could take, plus the identity fields
 * themselves, so a handler that trusts any of them is caught.
 */
export function victimValueFor(name: string): unknown {
  return valueFor(name, V, VICTIM);
}

/** The same parameter, pointing at the attacker's own account. */
export function attackerValueFor(name: string): unknown {
  return valueFor(name, A, ATTACKER);
}

type IdSet = typeof V;

function valueFor(name: string, ids: IdSet, uid: string): unknown {
  const n = name.toLowerCase();
  const plural = /ids$|s$/.test(n) && !/status$|address$|alias$/.test(n);
  const pick = (id: string) => (plural ? [id] : id);
  if (/(^|_)(user|uid|owner|target|account)/.test(n) || n === "uid" || n === "userid") return pick(uid);
  if (n.includes("transaction") || n === "txid" || n === "txids") return pick(ids.transaction);
  if (n.includes("file")) return pick(ids.file);
  if (n.includes("partner")) return pick(ids.partner);
  if (n.includes("source") || n.includes("bank") || n.includes("account")) return pick(ids.source);
  if (n.includes("categor")) return pick(ids.category);
  if (n.includes("import")) return pick(ids.import);
  if (n.includes("integration") || n.includes("mail")) return pick(ids.integration);
  if (n.includes("invoice")) return pick(ids.invoice);
  if (n.includes("connection")) return pick(ids.connection);
  if (n.includes("session") || n.includes("chat")) return pick(ids.chat);
  if (n.includes("notification")) return pick(ids.notification);
  if (n.includes("key")) return pick(ids.apiKey);
  if (n.includes("path") || n.includes("url")) return ids.storagePath;
  if (n === "id" || n === "ids" || n.endsWith("id") || n.endsWith("ids")) return pick(ids.transaction);
  return undefined;
}

/**
 * Turn a payload that worked against the attacker's own account into the same
 * payload aimed at the victim: every attacker id (and the attacker uid)
 * replaced by its victim counterpart, everything else left exactly as it was.
 */
export function retarget(payload: unknown): unknown {
  const swap = new Map<string, string>(
    (Object.keys(A) as Array<keyof typeof A>).map((k) => [A[k], V[k]] as [string, string]),
  );
  swap.set(ATTACKER, VICTIM);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      let out = v;
      for (const [from, to] of swap) out = out.split(from).join(to);
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(payload);
}

/** Every victim id, for payloads that want them all at once. */
export const ALL_VICTIM_IDS = [
  V.source, V.transaction, V.file, V.partner, V.category, V.import, V.integration,
  V.invoice, V.connection, V.chat, V.notification, V.apiKey,
];

/** Resolve after `ms` with a marker instead of hanging the run on one call. */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), ms);
  });
  try {
    return await Promise.race([p, t]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
