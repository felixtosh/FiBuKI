/**
 * No client SDK write targets the Transactions table (#794, ADR-0018).
 *
 * Transactions are read-only for the browser on the data plane, because a
 * Transaction in the Closed stretch must refuse every change and only the
 * callables check that. Same trees as browser-writes.test.ts (app/api is
 * server code and stays out). browser-writes.test.ts counts write
 * calls per file whatever they write; this one looks at what each write
 * targets, so a write moved from one table to Transactions cannot hide in an
 * unchanged count.
 *
 * A static walk, like browser-writes.test.ts: a write is `addDoc`, `setDoc`,
 * `updateDoc`, `deleteDoc`, or `update` / `set` / `delete` on a batch made by
 * `writeBatch`. Its target is followed back to the collection it names,
 * through variables (by their own declaration), for-of loops, `.ref`, `doc()`,
 * `collection()` and queries, and it counts when that collection is
 * `TRANSACTIONS_COLLECTION` or "transactions".
 *
 *   npx vitest run --config vitest.selfhost.config.ts src/selfhost/browser-transaction-writes.test.ts --pool=forks --maxWorkers=1
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative, sep } from "path";
import * as ts from "typescript";

const FREE_WRITES = new Set(["addDoc", "setDoc", "updateDoc", "deleteDoc"]);
const BATCH_WRITES = new Set(["update", "set", "delete"]);
const TRANSACTIONS = /\bTRANSACTIONS_COLLECTION\b|["'`]transactions["'`]/;

function kindOf(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return /\.[mc]?ts$/.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** Writes in one source whose target names the Transactions table, as `line: text`. */
export function transactionWrites(source: string, path = "file.ts"): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kindOf(path));
  const host = ts.createCompilerHost({});
  const program = ts.createProgram({
    rootNames: [path],
    options: { noResolve: true, noLib: true, allowJs: true, types: [] },
    host: { ...host, getSourceFile: (name) => (name === path ? file : undefined), fileExists: (name) => name === path },
  });
  const checker = program.getTypeChecker();

  // What a name is built from, by its own declaration: a variable's
  // initializer, or the iterable of the for-of loop that binds it.
  const builtFrom = (name: ts.Identifier): ts.Node[] => {
    const symbol = checker.getSymbolAtLocation(name);
    return (symbol?.declarations ?? []).flatMap((decl) => {
      if (!ts.isVariableDeclaration(decl)) return [];
      if (decl.initializer) return [decl.initializer];
      const loop = decl.parent?.parent;
      return loop && ts.isForOfStatement(loop) ? [loop.expression] : [];
    });
  };
  const isBatch = (name: ts.Identifier) =>
    builtFrom(name).some(
      (from) => ts.isCallExpression(from) && ts.isIdentifier(from.expression) && from.expression.text === "writeBatch",
    );

  // What a target is built from: a name's initializer, an object's owner
  // (`d.ref`), a reference's collection (`doc(db, "transactions", id)`), or a
  // query's source (`getDocs(query(collection(...)))`). Write data is not
  // followed, so an id read off a Transaction does not make its target one.
  const targetText = (node: ts.Node, seen = new Set<string>()): string => {
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) return "";
      seen.add(node.text);
      return builtFrom(node).map((from) => targetText(from, seen)).join(" ");
    }
    if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
      return targetText(node.expression, seen);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return targetText(node.expression, seen);
    if (ts.isCallExpression(node)) {
      const [first, second] = node.arguments;
      const name = ts.isIdentifier(node.expression) ? node.expression.text : "";
      if (name === "doc" || name === "collection") {
        return [second ? second.getText(file) : "", first ? targetText(first, seen) : ""].join(" ");
      }
      if (ts.isPropertyAccessExpression(node.expression)) return targetText(node.expression.expression, seen);
      return first ? targetText(first, seen) : "";
    }
    return node.getText(file);
  };

  const found: string[] = [];
  walk(file, (node) => {
    if (!ts.isCallExpression(node) || node.arguments.length === 0) return;
    const callee = node.expression;
    const isFree = ts.isIdentifier(callee) && FREE_WRITES.has(callee.text);
    const onBatch =
      ts.isPropertyAccessExpression(callee) &&
      BATCH_WRITES.has(callee.name.text) &&
      ts.isIdentifier(callee.expression) &&
      isBatch(callee.expression);
    if (!isFree && !onBatch) return;
    if (TRANSACTIONS.test(targetText(node.arguments[0]))) {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      found.push(`${line}: ${node.getText(file).split("\n")[0]}`);
    }
  });
  return found;
}

const repoRoot = join(__dirname, "..", "..", "..");
const SKIPPED = new Set(["lib/selfhost/firestore-client.ts"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      out.push(...sourceFiles(path));
    } else if (/\.[mc]?[jt]sx?$/.test(entry.name) && !/\.test\.[mc]?[jt]sx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

describe("the pattern", () => {
  it("finds a write whose target is built from the Transactions table", () => {
    const shapes = [
      `await updateDoc(doc(db, "transactions", id), { a: 1 });`,
      `const ref = doc(ctx.db, TRANSACTIONS_COLLECTION, id); await deleteDoc(ref);`,
      `await addDoc(collection(db, "transactions"), data);`,
      `const batch = writeBatch(db); const txDoc = doc(db, TRANSACTIONS_COLLECTION, id); batch.update(txDoc, {});`,
      `const snap = await getDocs(query(collection(db, "transactions"))); const batch = writeBatch(db); for (const d of snap.docs) batch.update(d.ref, {});`,
    ];
    for (const shape of shapes) expect(transactionWrites(shape), shape).toHaveLength(1);
  });

  it("leaves writes to other tables, reads and server calls alone", () => {
    const shapes = [
      `await updateDoc(doc(db, "noReceiptCategories", id), { a: 1 });`,
      `const snap = await getDoc(doc(db, "transactions", id));`,
      `const batch = writeBatch(db); batch.update(doc(db, "files", id), {});`,
      `await callFunction("removeNoReceiptCategory", { transactionId });`,
      `const cache = new Map(); cache.set(doc(db, "transactions", id), 1);`,
      `function a() { const ref = doc(db, "transactions", id); return getDoc(ref); } function b() { const ref = doc(db, "files", id); return deleteDoc(ref); }`,
      `const tx = await getDoc(doc(db, "transactions", id)); await updateDoc(doc(db, "noReceiptCategories", tx.data().categoryId), {});`,
    ];
    for (const shape of shapes) expect(transactionWrites(shape), shape).toEqual([]);
  });
});

describe("browser code", () => {
  it("write no Transaction through the client SDK", () => {
    const offenders: string[] = [];
    for (const tree of ["app", "lib", "components", "hooks"]) {
      for (const file of sourceFiles(join(repoRoot, tree))) {
        const path = relative(repoRoot, file).split(sep).join("/");
        if (SKIPPED.has(path) || path.startsWith("app/api/")) continue;
        for (const hit of transactionWrites(readFileSync(file, "utf8"), path)) offenders.push(`${path}:${hit}`);
      }
    }
    expect(offenders, "move these writes to a callable (ADR-0016, #794)").toEqual([]);
  });
});
