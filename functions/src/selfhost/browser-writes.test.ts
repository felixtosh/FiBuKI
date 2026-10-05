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
 * A static walk over TypeScript and JavaScript files, so it counts call
 * shapes, not intent: a call through an aliased import (`setDoc as put`)
 * counts, a call inside a string is counted all the same, a write behind a
 * helper outside lib/operations is counted where the helper lives (browser
 * code), not in the route. A route reaches the operations layer by named or
 * namespace import, through `@/lib/operations` or a relative path.
 *
 *   npx vitest run --config vitest.selfhost.config.ts src/selfhost/browser-writes.test.ts --pool=forks --maxWorkers=1
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, posix, relative, sep } from "path";

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
const WRITE_FUNCTIONS = ["addDoc", "setDoc", "updateDoc", "deleteDoc", "writeBatch", "runTransaction"];

/** Drops comments, so a write named in a comment is not counted. Strings are left alone. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Local names a write function is imported under (`import { setDoc as put }`), so a call through one counts. */
function writeAliases(source: string): string[] {
  const aliases: string[] = [];
  for (const m of stripComments(source).matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from/g)) {
    for (const a of m[1].matchAll(new RegExp(`\\b(?:${WRITE_FUNCTIONS.join("|")})\\s+as\\s+([\\w$]+)`, "g"))) {
      aliases.push(a[1]);
    }
  }
  return aliases;
}

/** Client write calls in `source`, by name or through an alias imported in `imports` (the whole file). */
function countClientWrites(source: string, imports: string = source): number {
  const names = [...WRITE_FUNCTIONS, ...writeAliases(imports)].map((n) => n.replace(/\$/g, "\\$"));
  const call = new RegExp(`(?<![\\w.$])(?:${names.join("|")})\\s*\\(`, "g");
  return [...stripComments(source).matchAll(call)].length;
}

/**
 * The top-level functions of the operations layer that write: a client write
 * call in their body, or a call to another one that does (across files, by
 * name). Chunks run from one top-level declaration to the next.
 */
function operationsWriters(files: Record<string, string>): Set<string> {
  const bodies = new Map<string, string>();
  const decl = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=/gm;
  const writers = new Set<string>();
  for (const source of Object.values(files)) {
    const text = stripComments(source);
    const starts = [...text.matchAll(decl)];
    starts.forEach((m, i) => {
      const end = i + 1 < starts.length ? starts[i + 1].index : text.length;
      const name = m[1] ?? m[2];
      const body = text.slice(m.index, end);
      bodies.set(name, body);
      if (countClientWrites(body, text) > 0) writers.add(name);
    });
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, body] of bodies) {
      if (writers.has(name)) continue;
      if ([...writers].some((w) => new RegExp(`\\b${w}\\s*\\(`).test(body.slice(body.indexOf("{"))))) {
        writers.add(name);
        grew = true;
      }
    }
  }
  return writers;
}

/** Whether an import specifier in the file at `path` names the operations layer: by alias or by relative path. */
function isOperationsModule(specifier: string, path: string): boolean {
  const target = specifier.startsWith(".") ? posix.join(posix.dirname(path), specifier) : specifier.replace(/^@\//, "");
  return /^lib\/operations(?:\/[\w-]+)?(?:\/index)?(?:\.[jt]s)?$/.test(target);
}

/**
 * Names the file at `path` (repo-relative) takes from the operations layer
 * (the barrel or one module): each named import, and each member used
 * through a namespace import (`ops.updateSource(...)`).
 */
function operationsImports(source: string, path: string): string[] {
  const names: string[] = [];
  const text = stripComments(source);
  for (const m of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    if (!isOperationsModule(m[2], path)) continue;
    for (const part of m[1].split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
      if (name) names.push(name);
    }
  }
  for (const m of text.matchAll(/import\s*(?:type\s*)?\*\s*as\s+([\w$]+)\s+from\s*["']([^"']+)["']/g)) {
    if (!isOperationsModule(m[2], path)) continue;
    const ns = m[1].replace(/\$/g, "\\$");
    const members = new Set([...text.matchAll(new RegExp(`(?<![\\w.$])${ns}\\s*\\.\\s*(\\w+)`, "g"))].map((u) => u[1]));
    names.push(...members);
  }
  return names;
}

const repoRoot = join(__dirname, "..", "..", "..");
const rel = (path: string) => relative(repoRoot, path).split(sep).join("/");

/** A source file the walk reads: TypeScript or JavaScript, not a test. */
function isSourceFile(name: string): boolean {
  return /\.m?[jt]sx?$/.test(name) && !/\.test\.m?[jt]sx?$/.test(name);
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
      const n = countClientWrites(readFileSync(file, "utf8"));
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
    const n = countClientWrites(source) + operationsImports(source, rel(file)).filter((name) => writers.has(name)).length;
    if (n > 0) counts[rel(file)] = n;
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
    const writers = operationsWriters({
      "a-ops.ts": [
        `import { deleteDoc as remove } from "firebase/firestore";`,
        `export async function aliased(ctx) { await remove(doc(ctx.db, "x", "1")); }`,
      ].join("\n"),
    });
    expect([...writers]).toEqual(["aliased"]);
  });

  it("read JavaScript files as well as TypeScript, never tests", () => {
    for (const name of ["a.ts", "a.tsx", "a.js", "a.jsx", "a.mjs", "a.mts"]) expect(isSourceFile(name), name).toBe(true);
    for (const name of ["a.test.ts", "a.test.tsx", "a.test.js", "a.test.mjs", "a.json", "a.css"]) {
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

  it("read the operations layer imported by relative path", () => {
    const source = [
      `import { updateSource } from "../../../lib/operations/source-ops";`,
      `import * as ops from "../../../lib/operations";`,
      `import { notOps } from "../../lib/operations";`,
      `ops.deleteSource(ctx, id);`,
    ].join("\n");
    expect(operationsImports(source, "app/api/x/route.ts")).toEqual(["updateSource", "deleteSource"]);
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
