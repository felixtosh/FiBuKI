/**
 * The File facts module is the only code that writes a File's extracted facts
 * (#637). Every writer outside it carried its own copy of the derived fields,
 * and each copy missed some: the Due Date a corrected issue date left behind,
 * the direction a sweep flipped back. A new writer would start that drift
 * again, so this walk fails the build when one appears in `functions/src`,
 * `app`, `lib`, `components` or `hooks`.
 *
 * ALLOWED holds the writers the next slice moves into the module: the
 * identity sweep, Not Invoice, generated invoices and the entity-name backfill
 * (#640). Extraction writes through the module since #639. Those entries only
 * shrink; when they are gone the module is the one writer. Besides them it
 * names files that write no File's facts: a test fixture and one-off
 * row-shape migrations.
 *
 * A static walk, so it reads shapes, not intent. A line it flags that writes
 * no extracted fact goes in ALLOWED with the reason, never a looser pattern.
 *
 *   npx vitest run src/fileFacts/__tests__/one-writer.test.ts --pool=forks --maxWorkers=1
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, sep } from "path";

/** The stored fields that are a File's extracted facts, or its Hand Correction record. */
const FACTS = [
  "extractedAmount",
  "extractedVatAmount",
  "extractedVatPercent",
  "extractedDate",
  "extractedLineItems",
  "extractedRateGroups",
  "extractedTipAmount",
  "extractedTipBound",
  "extractedDueDate",
  "extractedDebitDate",
  "extractedPartner",
  "extractedVatId",
  "extractedIban",
  "extractedAddress",
  "extractedAdditionalFields",
  "invoiceDirection",
  "extractionCorrectedFields",
  "extractionCorrectedAt",
  "lastFactChange",
].join("|");

/** One call argument: a name, a member chain or a call, as far as a static walk can tell. */
const ARG = `(?:[\\w.\\[\\]"']|\\([^()]*\\))+`;
/** An object literal's body up to the key, nested one level deep at most. */
const BODY = `(?:[^{}]|\\{[^{}]*\\})*?`;

const RULES: Array<[string, RegExp]> = [
  // `updates.extractedAmount = 9000`, `updateData["invoiceDirection"] = ...`
  ["field assignment", new RegExp(`(?:\\.\\s*(?:${FACTS})|\\[\\s*["'](?:${FACTS})["']\\s*\\])\\s*=(?![=>])`)],
  // `ref.update({ extractedPartner: ... })`, `batch.update(ref, { ..., extractedDate: ... })`,
  // `db.collection("files").doc(id).set({ ... })`. A two-argument `set` is a
  // batch's or a transaction's; a Map's `set(key, value)` is not a write.
  [
    "write literal (Admin SDK)",
    new RegExp(
      `(?:\\.(?:update|create)\\(\\s*(?:${ARG}\\s*,\\s*)?|\\.set\\(\\s*|\\b(?:\\w*[Bb]atch|\\w*[Tt]ransaction|tx|t)\\.set\\(\\s*${ARG}\\s*,\\s*)\\{${BODY}\\b(?:${FACTS})\\s*:`
    ),
  ],
  // The client SDK's free functions.
  ["write literal (client SDK)", new RegExp(`(?:updateDoc|setDoc)\\(\\s*${ARG}\\s*,\\s*\\{${BODY}\\b(?:${FACTS})\\s*:`)],
  // A builder of the update a caller then writes: `function buildXUpdates() {
  // return { extractedAmount: null, ... } }`, `const newFileData = { ... }`.
  [
    "update builder",
    new RegExp(
      `(?:function\\s+(?:build|draft)\\w*(?:Updates|Fields)\\s*\\([^)]*\\)[^{]*\\{(?:(?!\\n\\})[\\s\\S])*?|const\\s+\\w*(?:[Uu]pdates?|[Ff]ileData|[Ff]ields)\\w*\\s*(?::[^=\\n]+)?=\\s*\\{${BODY})\\b(?:${FACTS})\\s*:`
    ),
  ],
];

const f = (...parts: string[]) => parts.join(sep);

/** Path (from the repo root) -> which slice moves it into the module, or why it writes no fact. */
const ALLOWED: Record<string, string> = {
  // #640: the other writers of extracted facts.
  [f("functions", "src", "matching", "onUserDataUpdate.ts")]: "#640: the identity sweep",
  [f("functions", "src", "files", "backfillFileEntityNames.ts")]: "#640: the entity-name backfill (#299)",
  [f("functions", "src", "files", "notInvoiceOps.ts")]: "#640: marking a File Not Invoice",
  [f("functions", "src", "invoicing", "buildInvoiceFileFields.ts")]: "#640: a generated invoice's File",
  [f("functions", "src", "invoicing", "duplicateInvoice.ts")]: "#640: a generated invoice's draft File",
  // Not writers of a File's facts.
  [f("functions", "src", "selfhost", "security", "victim.ts")]: "seeds the cross-user suites' fixture",
  [f("functions", "src", "selfhost", "migrate-strip-line-item-fields.ts")]:
    "a one-off migration (#252) that drops two keys from stored rows and changes no fact",
  [f("functions", "src", "selfhost", "migrate-gross-up-net-line-items.ts")]:
    "a one-off migration that restates net rows in the gross form the row contract names; " +
    "every row keeps its net and VAT, and no document figure moves",
};

const repoRoot = join(__dirname, "..", "..", "..", "..");
const moduleDir = join(repoRoot, "functions", "src", "fileFacts");

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

describe("the File facts module is the only writer of extracted facts", () => {
  it("each rule catches the shape it is for", () => {
    const shapes = [
      `updates.extractedAmount = 9000;`,
      `updateData.invoiceDirection = data.invoiceDirection ?? "unknown";`,
      `update["extractedDueDate"] = null;`,
      `await fileRef.update({ extractedPartner: name });`,
      `batch.update(doc.ref, {\n  updatedAt: now,\n  extractedVatId: vatId,\n});`,
      `await db.collection("files").doc(id).set({ userId, extractedDate: day });`,
      `await updateDoc(doc(db, "files", id), { invoiceDirection: "outgoing" });`,
      `export function buildMarkNotInvoiceUpdates(previous) {\n  return {\n    isNotInvoice: true,\n    extractedAmount: null,\n  };\n}`,
      `const newFileData: Record<string, unknown> = {\n  userId,\n  invoiceDirection: "outgoing",\n};`,
    ];
    for (const shape of shapes) expect(findings(shape), shape).not.toEqual([]);

    // A Map's set is not a write.
    expect(findings(`filesMap.set(fileId, { extractedDate: data?.extractedDate });`)).toEqual([]);

    // Reads are not writes.
    expect(findings(`const same = file.extractedAmount === 9000;`)).toEqual([]);
    expect(findings(`const amount = data.extractedAmount ?? null;`)).toEqual([]);
    expect(findings(`return { extractedAmount: data.extractedAmount };`)).toEqual([]);
    expect(findings(`await ref.update({ transactionSuggestions: [] });`)).toEqual([]);
  });

  it("no code outside it writes a File's extracted facts", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name === ".next") continue;
          if (path === moduleDir) continue;
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

  it("every allowance still names a file that writes a fact", () => {
    for (const relative of Object.keys(ALLOWED)) {
      const source = readFileSync(join(repoRoot, relative), "utf8");
      expect(findings(source), relative).not.toEqual([]);
    }
  });
});
