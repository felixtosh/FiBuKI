/**
 * The browser reads domain data; only the server writes it (ADR-0016, #624).
 *
 * Two ratchets. Each counts write calls per file and requires each file's
 * count to equal its allowance below:
 *
 * - **Browser code** (`app` outside `app/api`, `lib`, `components`, `hooks`):
 *   every client SDK write call.
 * - **Server routes** (`app/api`): every client SDK write call, and every
 *   operations-layer writer (a `lib/operations` function that writes through
 *   the client SDK) a route imports. On self-host the client SDK goes through
 *   the data plane with the same policy as a browser, so such a route breaks
 *   the day its table locks. It moves to the Admin SDK with its table.
 *
 * A new write fails the build. A file whose count drops fails too, until its
 * allowance is lowered (or its entry removed), so the lists only ever shrink.
 * Never raise a number: a new write is a callable built with `createCallable()`.
 *
 * A static walk over the syntax tree of TypeScript and JavaScript files
 * (`ts.createSourceFile`, as in browser-imports.test.ts). It follows a file's
 * bindings, not its types: a write function is counted when called by name,
 * through an alias or a re-bound name, through a namespace of the module
 * (`fs.setDoc`, `fs["setDoc"]`), or off `import()` / `require()`. A route
 * reaches the operations layer the same ways, by `@/lib/operations` or a
 * relative path. Scope is ignored, so a shadowing name is counted too. A
 * write behind a helper outside lib/operations is counted where the helper
 * lives (browser code), not in the route.
 *
 *   npx vitest run --config vitest.selfhost.config.ts src/selfhost/browser-writes.test.ts --pool=forks --maxWorkers=1
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, posix, relative, sep } from "path";
import * as ts from "typescript";

type Allowances = Record<string, { count: number; why: string }>;

/**
 * Browser code: path (from the repo root, `/`-separated) -> how many client
 * write calls it holds today, and why or which ticket moves them.
 */
const BROWSER_ALLOWED: Allowances = {
  "lib/operations/category-ops.ts": { count: 10, why: "No-document Categories (#629, #630)" },
  "lib/operations/chat-ops.ts": { count: 5, why: "chat sessions stay writable (ADR-0016)" },
  "lib/operations/email-inbound-ops.ts": { count: 4, why: "inbound email addresses (#626)" },
  "lib/operations/email-integration-ops.ts": { count: 1, why: "removeEmailPatternFromPartner: Partner email learning (#631)" },
  "lib/operations/file-ops.ts": { count: 5, why: "assigning a Partner to a File (#627); Files lock in #635" },
  "lib/operations/invite-ops.ts": { count: 3, why: "allowed emails: an admin table, admins only (ADR-0016)" },
  "lib/operations/notification-ops.ts": { count: 2, why: "marking notifications read stays writable (ADR-0016)" },
  "lib/operations/partner-ops.ts": {
    count: 8,
    why: "global Partners, promotion candidates and presets: admins only (ADR-0016); addEmailDomainToPartner (#631)",
  },
  "lib/operations/remap-ops.ts": { count: 1, why: "import remap (#628)" },
  "lib/operations/source-ops.ts": { count: 1, why: "sources (#634)" },
  "lib/operations/user-data-ops.ts": { count: 1, why: "business identity (#632)" },
  "hooks/use-worker-queue.ts": { count: 6, why: "worker jobs (#633)" },
};

/** Server routes: path -> client write calls plus operations-layer writers imported. */
const ROUTE_ALLOWED: Allowances = {
  "app/api/browser/log/route.ts": { count: 1, why: "browser debug log, not a domain table" },
  "app/api/email-inbound/[id]/regenerate/route.ts": { count: 1, why: "inbound email addresses (#626)" },
  "app/api/email-inbound/[id]/route.ts": { count: 2, why: "inbound email addresses (#626)" },
  "app/api/email-inbound/route.ts": { count: 1, why: "inbound email addresses (#626)" },
  "app/api/sources/delete-orphans/route.ts": { count: 3, why: "sources (#634)" },
  "app/api/truelayer/accounts/route.ts": { count: 4, why: "sources (#634)" },
  "app/api/truelayer/callback/route.ts": { count: 1, why: "bank connections (#634)" },
  "app/api/truelayer/sync/route.ts": { count: 3, why: "sources (#634)" },
};

/** Not browser writers, never counted. */
const SKIPPED: Record<string, string> = {
  "lib/selfhost/firestore-client.ts": "the self-host client SDK itself: it defines these functions",
};

/** The client SDK's write functions: Firestore's free functions, not the Admin SDK's methods (`db.runTransaction`). */
const WRITE_FUNCTIONS = new Set(["addDoc", "setDoc", "updateDoc", "deleteDoc", "writeBatch", "runTransaction"]);

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (/\.[mc]?ts$/.test(path)) return ts.ScriptKind.TS;
  return path.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
}

/** `(x)`, `await x`, `x as T`, `x!` -> `x`. */
function unwrap(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAwaitExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

/** The module `import("x")` or `require("x")` loads. */
function loadedModule(node: ts.Expression): string | undefined {
  const call = unwrap(node);
  if (!ts.isCallExpression(call) || !call.arguments[0] || !ts.isStringLiteralLike(call.arguments[0])) return undefined;
  const callee = call.expression;
  const loads = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require");
  return loads ? call.arguments[0].text : undefined;
}

/** The member `x.name` or `x["name"]` reads. */
function memberName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return undefined;
}

/** A property name in a binding pattern or import: `a` in `{ a: b }`, `"a"` in `{ "a": b }`. */
function propertyText(node: ts.Node): string | undefined {
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
}

function visitAll(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => visitAll(child, visit));
}

/**
 * One file's module bindings, by local name. A namespace is a name bound to a
 * whole module (`import * as ns`, `const ns = await import(...)`,
 * `require(...)`; not a default import, which is whatever the module chose to
 * export, an Admin SDK instance included); a member is a name bound to one
 * export (a named import, or one destructured off a namespace or a loaded
 * module).
 * Scope is ignored: a name bound anywhere in the file counts everywhere in it.
 */
interface Scan {
  file: ts.SourceFile;
  namespaces: Map<string, string>;
  members: Map<string, { from: string; name: string }>;
}

function scanFile(source: string, path: string): Scan {
  // Parsed as a module, so a top-level `await` is one even in a file without an import.
  const options: ts.CreateSourceFileOptions = {
    languageVersion: ts.ScriptTarget.Latest,
    setExternalModuleIndicator: (f) => {
      (f as { externalModuleIndicator?: unknown }).externalModuleIndicator = true;
    },
  };
  const file = ts.createSourceFile(path, source, options, true, scriptKind(path));
  const namespaces = new Map<string, string>();
  const members = new Map<string, { from: string; name: string }>();
  const scan: Scan = { file, namespaces, members };
  let grew = true;
  const bind = <V>(map: Map<string, V>, name: string, value: V) => {
    if (!map.has(name)) {
      map.set(name, value);
      grew = true;
    }
  };
  // A namespace bound from another (`const b = a`) needs the first one first.
  while (grew) {
    grew = false;
    visitAll(file, (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const from = node.moduleSpecifier.text;
        const clause = node.importClause;
        const named = clause?.namedBindings;
        if (named && ts.isNamespaceImport(named)) bind(namespaces, named.name.text, from);
        if (named && ts.isNamedImports(named)) {
          for (const el of named.elements) bind(members, el.name.text, { from, name: (el.propertyName ?? el.name).text });
        }
      }
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteral(node.moduleReference.expression)
      ) {
        bind(namespaces, node.name.text, node.moduleReference.expression.text);
      }
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const from = moduleOf(scan, node.initializer);
        if (from === undefined) return;
        if (ts.isIdentifier(node.name)) bind(namespaces, node.name.text, from);
        if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            const name = propertyText(el.propertyName ?? el.name);
            if (name && ts.isIdentifier(el.name)) bind(members, el.name.text, { from, name });
          }
        }
      }
    });
  }
  return scan;
}

/** The module an expression stands for: a namespace's name, or `import(...)` / `require(...)` itself. */
function moduleOf(scan: Scan, node: ts.Expression): string | undefined {
  const inner = unwrap(node);
  return ts.isIdentifier(inner) ? scan.namespaces.get(inner.text) : loadedModule(inner);
}

/**
 * The local names that hold a client write function: the function's own name,
 * a name it is imported or destructured under, and a name it is re-bound to
 * (`const put = setDoc`, `put = fs.setDoc`).
 */
function writeNames(scan: Scan): Set<string> {
  const names = new Set(WRITE_FUNCTIONS);
  for (const [local, { name }] of scan.members) if (WRITE_FUNCTIONS.has(name)) names.add(local);
  for (let grew = true; grew; ) {
    grew = false;
    visitAll(scan.file, (node) => {
      let local: string | undefined;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isWrite(scan, names, node.initializer)) {
        local = node.name.text;
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        isWrite(scan, names, node.right)
      ) {
        local = node.left.text;
      }
      if (local && !names.has(local)) {
        names.add(local);
        grew = true;
      }
    });
  }
  return names;
}

/** Whether an expression is a client write function: one of `names`, `ns.setDoc`, `ns["setDoc"]`, `setDoc.bind(...)`. */
function isWrite(scan: Scan, names: Set<string>, node: ts.Expression): boolean {
  const inner = unwrap(node);
  if (ts.isIdentifier(inner)) return names.has(inner.text);
  if (ts.isCallExpression(inner) && memberName(inner.expression) === "bind") {
    return isWrite(scan, names, (inner.expression as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression);
  }
  const member = memberName(inner);
  if (member === undefined || !(ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner))) return false;
  if (WRITE_FUNCTIONS.has(member) && moduleOf(scan, inner.expression) !== undefined) return true;
  // `setDoc.call(...)`, `setDoc.apply(...)`
  return (member === "call" || member === "apply") && isWrite(scan, names, inner.expression);
}

/** Client write calls under `node` (the whole file by default). */
function countWriteCalls(scan: Scan, node: ts.Node = scan.file, names: Set<string> = writeNames(scan)): number {
  let n = 0;
  visitAll(node, (child) => {
    if (ts.isCallExpression(child) && isWrite(scan, names, child.expression)) n++;
  });
  return n;
}

function countClientWrites(source: string, path = "file.ts"): number {
  // Every shape starts from a write function's name, so a file without one needs no parse.
  if (![...WRITE_FUNCTIONS].some((name) => source.includes(name))) return 0;
  return countWriteCalls(scanFile(source, path));
}

/**
 * The top-level functions of the operations layer that write: a client write
 * call in their body, or a call to another one that does (across files, by
 * name).
 */
function operationsWriters(files: Record<string, string>): Set<string> {
  const bodies = new Map<string, { writes: boolean; calls: Set<string> }>();
  for (const [path, source] of Object.entries(files)) {
    const scan = scanFile(source, path);
    const names = writeNames(scan);
    const declare = (name: string, body: ts.Node) => {
      const calls = new Set<string>();
      visitAll(body, (node) => {
        if (!ts.isCallExpression(node)) return;
        const callee = unwrap(node.expression);
        const called = ts.isIdentifier(callee) ? callee.text : memberName(callee);
        if (called) calls.add(called);
      });
      bodies.set(name, { writes: countWriteCalls(scan, body, names) > 0, calls });
    };
    for (const statement of scan.file.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) declare(statement.name.text, statement);
      if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer) declare(decl.name.text, decl.initializer);
        }
      }
    }
  }
  const writers = new Set([...bodies].filter(([, b]) => b.writes).map(([name]) => name));
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, { calls }] of bodies) {
      if (!writers.has(name) && [...calls].some((c) => writers.has(c))) {
        writers.add(name);
        grew = true;
      }
    }
  }
  return writers;
}

/** Whether an import specifier in the file at `path` names the operations layer: by alias or by relative path. */
function isOperationsModule(specifier: string, path: string): boolean {
  const resolved = specifier.startsWith(".") ? posix.join(posix.dirname(path), specifier) : specifier.replace(/^@\//, "");
  const target = resolved.replace(/\/+$/, "");
  return /^lib\/operations(?:\/[\w-]+)?(?:\/index)?(?:\.[mc]?[jt]s)?$/.test(target);
}

/**
 * Names the file at `path` (repo-relative) takes from the operations layer
 * (the barrel or one module), each once: a named import, a name destructured
 * off it, and a member read off a namespace of it (`ops.x`, `ops["x"]`,
 * `(await import(...)).x`).
 */
function operationsImports(source: string, path: string): string[] {
  if (!source.includes("operations")) return [];
  const scan = scanFile(source, path);
  const names = new Set<string>();
  for (const { from, name } of scan.members.values()) if (isOperationsModule(from, path)) names.add(name);
  visitAll(scan.file, (node) => {
    const member = memberName(node);
    if (member === undefined || !(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) return;
    const from = moduleOf(scan, node.expression);
    if (from !== undefined && isOperationsModule(from, path)) names.add(member);
  });
  return [...names];
}

const repoRoot = join(__dirname, "..", "..", "..");
const rel = (path: string) => relative(repoRoot, path).split(sep).join("/");

/** A source file the walk reads: TypeScript or JavaScript, not a test. */
function isSourceFile(name: string): boolean {
  return /\.[mc]?[jt]sx?$/.test(name) && !/\.test\.[mc]?[jt]sx?$/.test(name);
}

function sourceFiles(dir: string, skipDir: (path: string) => boolean = () => false): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__" || skipDir(path)) continue;
      out.push(...sourceFiles(path, skipDir));
    } else if (isSourceFile(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

const apiDir = join(repoRoot, "app", "api");

function browserWrites(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const tree of ["app", "lib", "components", "hooks"]) {
    for (const file of sourceFiles(join(repoRoot, tree), (p) => p === apiDir)) {
      const path = rel(file);
      if (SKIPPED[path]) continue;
      const n = countClientWrites(readFileSync(file, "utf8"), path);
      if (n > 0) counts[path] = n;
    }
  }
  return counts;
}

function routeWrites(): Record<string, number> {
  const opsDir = join(repoRoot, "lib", "operations");
  const ops = Object.fromEntries(sourceFiles(opsDir).map((f) => [f, readFileSync(f, "utf8")]));
  const writers = operationsWriters(ops);
  const counts: Record<string, number> = {};
  for (const file of sourceFiles(apiDir)) {
    const source = readFileSync(file, "utf8");
    const path = rel(file);
    const n = countClientWrites(source, path) + operationsImports(source, path).filter((name) => writers.has(name)).length;
    if (n > 0) counts[path] = n;
  }
  return counts;
}

function ratchet(actual: Record<string, number>, allowed: Allowances): string[] {
  const problems: string[] = [];
  for (const [path, n] of Object.entries(actual)) {
    const allowance = allowed[path]?.count ?? 0;
    if (n > allowance) problems.push(`${path}: ${n} write(s), ${allowance} allowed. Write through a callable (ADR-0016).`);
    else if (n < allowance) problems.push(`${path}: ${n} write(s), ${allowance} allowed. Lower its allowance to ${n}.`);
  }
  for (const path of Object.keys(allowed)) {
    if (!(path in actual)) problems.push(`${path}: no write left. Remove its allowance.`);
  }
  return problems;
}

describe("the patterns", () => {
  it("count client SDK writes and nothing else", () => {
    const counted = [
      `await addDoc(collection(db, "files"), data);`,
      `await setDoc(doc(db, "files", id), data, { merge: true });`,
      `await updateDoc(ref, { fileName });`,
      `await deleteDoc(ref);`,
      `const batch = writeBatch(db);`,
      `await runTransaction(db, async (tx) => tx.update(ref, data));`,
    ];
    for (const shape of counted) expect(countClientWrites(shape), shape).toBe(1);
    const ignored = [
      `await db.runTransaction(async (tx) => tx.update(ref, data));`,
      `await db.collection("files").doc(id).set(data);`,
      `const batch = db.batch();`,
      `  // await updateDoc(ref, data);`,
      `/* setDoc(ref, data) */`,
      `import { addDoc, setDoc } from "firebase/firestore";`,
      `await callFunction("updateFile", { fileId, data });`,
      `import { setDoc as put } from "firebase/firestore";`,
      `const hint = "call setDoc(ref, data) from the server";`,
      `await admin.firestore().runTransaction(async (tx) => tx.update(ref, data));`,
      `import * as fs from "firebase/firestore"; const snap = await fs.getDoc(ref);`,
      `import db from "@/lib/firebase/admin"; await db.runTransaction(async (tx) => tx.update(ref, data));`,
    ];
    for (const shape of ignored) expect(countClientWrites(shape), shape).toBe(0);
  });

  it("count a write called through an aliased import", () => {
    const source = [
      `import {`,
      `  doc,`,
      `  setDoc as put,`,
      `} from "firebase/firestore";`,
      `await put(doc(db, "files", "1"), {});`,
    ].join("\n");
    expect(countClientWrites(source)).toBe(1);
    expect(countClientWrites(`import firebase, { setDoc as put } from "firebase/firestore";\nput(ref, {});`)).toBe(1);
    const writers = operationsWriters({
      "a-ops.ts": [
        `import { deleteDoc as remove } from "firebase/firestore";`,
        `export async function aliased(ctx) { await remove(doc(ctx.db, "x", "1")); }`,
      ].join("\n"),
    });
    expect([...writers]).toEqual(["aliased"]);
  });

  it("find operations-layer writers that write through a namespace of the client SDK", () => {
    const writers = operationsWriters({
      "a-ops.ts": [
        `import * as fs from "firebase/firestore";`,
        `export async function viaNamespace(ctx) { await fs.updateDoc(fs.doc(ctx.db, "x", "1"), { a: 1 }); }`,
        `export async function readOnly(ctx) { return fs.getDoc(fs.doc(ctx.db, "x", "1")); }`,
      ].join("\n"),
    });
    expect([...writers]).toEqual(["viaNamespace"]);
  });

  it("count a write called through a namespace of the client SDK", () => {
    const source = [
      `import * as fs from "firebase/firestore";`,
      `await fs.setDoc(fs.doc(db, "files", "1"), {});`,
      `await fs["updateDoc"](ref, {});`,
      `const snap = await fs.getDoc(ref);`,
    ].join("\n");
    expect(countClientWrites(source)).toBe(2);
  });

  it("count a write called through a re-bound name", () => {
    const source = [
      `import { setDoc } from "firebase/firestore";`,
      `const put = setDoc;`,
      `let again;`,
      `again = put;`,
      `await put(ref, {});`,
      `await again(ref, {});`,
      `await setDoc.call(null, ref, {});`,
      `const bound = setDoc.bind(null);`,
      `await bound(ref, {});`,
    ].join("\n");
    expect(countClientWrites(source)).toBe(4);
  });

  it("count a write called through a dynamic import or require", () => {
    const source = [
      `const fs = await import("firebase/firestore");`,
      `await fs.addDoc(col, {});`,
      `const { deleteDoc: remove } = await import("firebase/firestore");`,
      `await remove(ref);`,
      `await (await import("firebase/firestore")).setDoc(ref, {});`,
      `const sdk = require("firebase/firestore");`,
      `sdk.writeBatch(db);`,
    ].join("\n");
    expect(countClientWrites(source)).toBe(4);
  });

  it("read JavaScript files as well as TypeScript, never tests", () => {
    for (const name of ["a.ts", "a.tsx", "a.js", "a.jsx", "a.mjs", "a.mts", "a.cjs", "a.cts"]) expect(isSourceFile(name), name).toBe(true);
    for (const name of ["a.test.ts", "a.test.tsx", "a.test.js", "a.test.mjs", "a.test.cjs", "a.json", "a.css"]) {
      expect(isSourceFile(name), name).toBe(false);
    }
  });

  it("find operations-layer writers, through a helper too", () => {
    const writers = operationsWriters({
      "a-ops.ts": [
        `export async function readIt(ctx) { return getDoc(doc(ctx.db, "x", "1")); }`,
        `async function write(ctx) { await updateDoc(doc(ctx.db, "x", "1"), { a: 1 }); }`,
        `export async function viaHelper(ctx) { await write(ctx); }`,
        `export const arrow = async (ctx) => { await deleteDoc(doc(ctx.db, "x", "1")); };`,
      ].join("\n"),
      "b-ops.ts": `export async function otherFile(ctx) { await viaHelper(ctx); }`,
    });
    expect([...writers].sort()).toEqual(["arrow", "otherFile", "viaHelper", "write"]);
  });

  it("read the names imported from the operations layer", () => {
    const source = [
      `import { createSource, listSources as list } from "@/lib/operations";`,
      `import type { OperationsContext } from "@/lib/operations/types";`,
      `import { getFile } from "@/lib/operations/file-ops";`,
      `import { other } from "@/lib/other";`,
    ].join("\n");
    expect(operationsImports(source, "app/api/x/route.ts")).toEqual([
      "createSource",
      "listSources",
      "OperationsContext",
      "getFile",
    ]);
  });

  it("read the members a namespace import of the operations layer uses", () => {
    const source = [
      `import * as ops from "@/lib/operations";`,
      `await ops.updateSource(ctx, id, data);`,
      `await ops.updateSource(ctx, id, more);`,
      `const s = await ops.getSource(ctx, id);`,
      `await other.deleteSource(ctx, id);`,
    ].join("\n");
    expect(operationsImports(source, "app/api/x/route.ts")).toEqual(["updateSource", "getSource"]);
  });

  it("read the members destructured off or bracket-read from the operations layer", () => {
    const source = [
      `import * as ops from "@/lib/operations";`,
      `const { deleteSource, updateSource: update } = ops;`,
      `await ops["createSource"](ctx, data);`,
    ].join("\n");
    expect(operationsImports(source, "app/api/x/route.ts")).toEqual(["deleteSource", "updateSource", "createSource"]);
  });

  it("read the operations layer loaded dynamically", () => {
    const source = [
      `const { deleteSource } = await import("@/lib/operations");`,
      `await (await import("../../../lib/operations/source-ops")).updateSource(ctx, id, data);`,
      `const later = await import("@/lib/operations");`,
      `await later.createSource(ctx, data);`,
      `const other = await import("@/lib/other");`,
      `await other.removeSource(ctx, id);`,
    ].join("\n");
    expect(operationsImports(source, "app/api/x/route.ts")).toEqual(["deleteSource", "updateSource", "createSource"]);
  });

  it("read the operations layer imported by relative path", () => {
    const source = [
      `import { updateSource } from "../../../lib/operations/source-ops";`,
      `import * as ops from "../../../lib/operations";`,
      `import { notOps } from "../../lib/operations";`,
      `import x, { createSource } from "../../../lib/operations/";`,
      `ops.deleteSource(ctx, id);`,
    ].join("\n");
    expect(operationsImports(source, "app/api/x/route.ts")).toEqual(["updateSource", "createSource", "deleteSource"]);
  });
});

describe("the browser does not gain a write", () => {
  it("every browser file holds exactly the client writes its allowance names", () => {
    expect(ratchet(browserWrites(), BROWSER_ALLOWED)).toEqual([]);
  });

  it("every skipped file still exists", () => {
    for (const path of Object.keys(SKIPPED)) {
      expect(() => readFileSync(join(repoRoot, path)), path).not.toThrow();
    }
  });
});

describe("a server route does not gain a client SDK write", () => {
  it("every route holds exactly the client writes its allowance names", () => {
    expect(ratchet(routeWrites(), ROUTE_ALLOWED)).toEqual([]);
  });
});
