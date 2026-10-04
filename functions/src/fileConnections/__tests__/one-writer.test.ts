/**
 * The File Connection writer is the only code that writes a connection record
 * or either id list (#612): the File's `transactionIds`, the Transaction's
 * `fileIds`. Eleven writers each carried their own guards before it, and each
 * missed some. A twelfth would start the drift again, so this walk fails the
 * build the moment one appears, in `functions/src`, `app`, `lib`,
 * `components` or `hooks`.
 *
 * A static walk, so it reads shapes, not intent. A line it flags that writes
 * none of the three goes in ALLOWED with the reason, never a looser pattern.
 *
 *   npx vitest run src/fileConnections/__tests__/one-writer.test.ts --pool=forks --maxWorkers=1
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, sep } from "path";

const RULES: Array<[string, RegExp]> = [
  // `transactionIds: FieldValue.arrayUnion(...)`, `fileIds: arrayRemove(...)`
  ["id list transform", /\b(?:transactionIds|fileIds)\s*:\s*(?:FieldValue\.)?array(?:Union|Remove)\(/],
  // `transactionIds: [transactionId]`, `fileIds: [...existing, fileId]`. An
  // empty list, which a new File or Transaction starts with, is not flagged.
  ["id list literal", /\b(?:transactionIds|fileIds)\s*:\s*\[\s*(?!\])/],
  // `.collection("fileConnections").add(...)` / `.doc()` / `.doc(id).set(...)`
  [
    "record write (Admin SDK)",
    /(?:"fileConnections"|'fileConnections'|FILE_CONNECTIONS_COLLECTION)\s*\)\s*\.\s*(?:add\(|doc\(\s*\)|doc\([^)]*\)\s*\.\s*(?:set|create|update|delete)\()/,
  ],
  // `batch.set(db.collection("fileConnections").doc(id), ...)`
  [
    "record write (batch)",
    /\.(?:set|create|update|delete)\(\s*[\w.]*collection\(\s*(?:"fileConnections"|'fileConnections'|FILE_CONNECTIONS_COLLECTION)/,
  ],
  // The client SDK's free functions on the collection.
  [
    "record write (client SDK)",
    /(?:addDoc|setDoc|updateDoc|deleteDoc)\(\s*(?:collection|doc)\(\s*[^)]*(?:"fileConnections"|'fileConnections'|FILE_CONNECTIONS_COLLECTION)/,
  ],
  // A write through the reference a query of the collection handed back:
  // `batch.delete(connDoc.ref)`, `connectionsQuery.docs[0].ref.delete()`.
  // Static, so it goes by the name the code gives a record, which every
  // writer before #612 spelled with "conn"; a record written through a
  // reference named otherwise is the one shape this walk cannot see.
  [
    "record write (by reference)",
    /(?:\.(?:delete|update|set)\(\s*\w*[Cc]onn\w*(?:\.docs\[\d+\])?\.ref\b|\b\w*[Cc]onn\w*(?:\.docs\[\d+\])?\.ref\.(?:delete|update|set)\()/,
  ],
];

/** Path (from the repo root) -> why its flagged lines write none of the three, or write them legitimately. */
const ALLOWED: Record<string, string> = {
  [`functions${sep}src${sep}user${sep}deleteUserAccountCallable.ts`]:
    "deletes every record of an account being deleted, the account's Files and Transactions with it",
  [`functions${sep}src${sep}user${sep}processPendingDeletions.ts`]:
    "the scheduled half of the account deletion above",
  [`functions${sep}src${sep}user-import${sep}processUserImportQueue.ts`]:
    "restores a user's own export verbatim into their emptied account",
  [`functions${sep}src${sep}corrections${sep}resolveCorrections.ts`]:
    "builds an in-memory UVA view of a Transaction; writes nothing",
  [`functions${sep}src${sep}uva${sep}reconcile.ts`]: "a derivation's own fileIds, not a Transaction's",
  [`functions${sep}src${sep}selfhost${sep}security${sep}victim.ts`]: "seeds the cross-user suites' fixture",
  [`components${sep}sidebar${sep}transaction-details.tsx`]: "a callable's argument, not a stored list",
  [`functions${sep}src${sep}auth${sep}migrateUserData.ts`]:
    "moves every record of an account to its new uid, the account's Files and Transactions with it",
};

const repoRoot = join(__dirname, "..", "..", "..", "..");
const moduleDir = join(repoRoot, "functions", "src", "fileConnections");

function findings(source: string): string[] {
  const found: string[] = [];
  for (const [name, rule] of RULES) {
    const global = new RegExp(rule.source, "g");
    for (const match of source.matchAll(global)) {
      const line = source.slice(0, match.index).split("\n").length;
      found.push(`${name} at line ${line}`);
    }
  }
  return found;
}

describe("the File Connection writer is the only writer", () => {
  it("each rule catches the shape it is for", () => {
    const shapes = [
      `batch.update(fileRef, { transactionIds: FieldValue.arrayUnion(transactionId) });`,
      `await txRef.update({ fileIds: [...existingFileIds, fileId] });`,
      `await db.collection("fileConnections").add({ fileId });`,
      `const ref = db.collection("fileConnections").doc();`,
      `await db.collection("fileConnections").doc(id).set({ fileId });`,
      `batch.set(db.collection("fileConnections").doc(id), record);`,
      `await addDoc(collection(ctx.db, "fileConnections"), record);`,
      `for (const connDoc of snap.docs) batch.delete(connDoc.ref);`,
      `await connectionsQuery.docs[0].ref.delete();`,
    ];
    for (const shape of shapes) expect(findings(shape), shape).not.toEqual([]);
    expect(findings(`const file = { transactionIds: [], fileIds: [] };`)).toEqual([]);
    expect(findings(`const snap = await db.collection("fileConnections").where("fileId", "==", id).get();`)).toEqual([]);
  });

  it("no code outside it writes a connection record or either id list", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "__tests__" || path === moduleDir) continue;
          walk(path);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
        const relative = path.slice(repoRoot.length + 1);
        if (ALLOWED[relative]) continue;
        for (const finding of findings(readFileSync(path, "utf8"))) offenders.push(`${relative}: ${finding}`);
      }
    };
    for (const tree of [join("functions", "src"), "app", "lib", "components", "hooks"]) {
      walk(join(repoRoot, tree));
    }
    expect(offenders).toEqual([]);
  });

  it("every allowance still names a file that exists", () => {
    for (const relative of Object.keys(ALLOWED)) {
      expect(() => readFileSync(join(repoRoot, relative)), relative).not.toThrow();
    }
  });
});
