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
 * A static walk, so it counts call shapes, not intent: a call inside a string
 * is counted all the same, a write behind a helper outside lib/operations is
 * counted where the helper lives (browser code), not in the route.
 *
 *   npx vitest run --config vitest.selfhost.config.ts src/selfhost/browser-writes.test.ts --pool=forks --maxWorkers=1
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative, sep } from "path";

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

/** The client SDK's write calls: Firestore's free functions, not the Admin SDK's methods (`db.runTransaction`). */
const CLIENT_WRITE = /(?<![\w.$])(?:addDoc|setDoc|updateDoc|deleteDoc|writeBatch|runTransaction)\s*\(/g;

/** Drops comments, so a write named in a comment is not counted. Strings are left alone. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function countClientWrites(source: string): number {
  return [...stripComments(source).matchAll(CLIENT_WRITE)].length;
}

/**
 * The top-level functions of the operations layer that write: a client write
 * call in their body, or a call to another one that does (across files, by
 * name). Chunks run from one top-level declaration to the next.
 */
function operationsWriters(files: Record<string, string>): Set<string> {
  const bodies = new Map<string, string>();
  const decl = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=/gm;
  for (const source of Object.values(files)) {
    const text = stripComments(source);
    const starts = [...text.matchAll(decl)];
    starts.forEach((m, i) => {
      const end = i + 1 < starts.length ? starts[i + 1].index : text.length;
      bodies.set(m[1] ?? m[2], text.slice(m.index, end));
    });
  }
  const writers = new Set([...bodies].filter(([, body]) => countClientWrites(body) > 0).map(([name]) => name));
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

/** Names a file imports from `@/lib/operations` (the barrel or one module). */
function operationsImports(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']@\/lib\/operations(?:\/[\w-]+)?["']/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
      if (name) names.push(name);
    }
  }
  return names;
}

const repoRoot = join(__dirname, "..", "..", "..");
const rel = (path: string) => relative(repoRoot, path).split(sep).join("/");

function sourceFiles(dir: string, skipDir: (path: string) => boolean = () => false): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__" || skipDir(path)) continue;
      out.push(...sourceFiles(path, skipDir));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
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
    const n = countClientWrites(source) + operationsImports(source).filter((name) => writers.has(name)).length;
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
    ];
    for (const shape of ignored) expect(countClientWrites(shape), shape).toBe(0);
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
    expect(operationsImports(source)).toEqual(["createSource", "listSources", "OperationsContext", "getFile"]);
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
