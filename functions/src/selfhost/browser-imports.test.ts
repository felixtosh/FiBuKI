/**
 * Browser code reaches no Firebase server SDK, and `httpsCallable` stays inside
 * the wrappers (#688, #647 decision 3). The frontend imports backend modules
 * directly (`@/functions/src/...`); that is safe only while nothing it pulls in,
 * at any depth, imports `firebase-admin` or `firebase-functions`. A comment in a
 * module saying so is not a check, so this walk is.
 *
 * Three rules, over `app`, `components`, `hooks` and `lib` and everything they
 * import from `functions/src`:
 *
 * 1. **Browser code reaches neither SDK.** Browser code is every file in
 *    `components/` and `hooks/`, every file that says "use client", and every
 *    file one of those imports, at any depth (client `lib` is what they reach).
 *    A route, a server component in `app/` (no "use client") and the `lib`
 *    reached only from those are server code.
 * 2. **Server code may reach `firebase-admin`** (the app has it), **never
 *    `firebase-functions`** (the app does not install it).
 * 3. **`httpsCallable` lives in the client wrapper and the self-host shim.**
 *    The files in CALLABLE_RATCHET call it directly today. The list only
 *    shrinks: a new caller fails, and so does an entry whose file stopped
 *    calling it, until the entry goes.
 *
 * A static walk of import shapes: `import`/`export ... from`, side-effect
 * `import "x"`, `import("x")` and `require("x")`. A type-only import (`import
 * type`, or braces holding only `type` names) is erased by the compiler, so it
 * is not followed.
 *
 *   npx vitest run --config vitest.selfhost.config.ts src/selfhost/browser-imports.test.ts --pool=forks --maxWorkers=1
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, posix } from "path";

const repoRoot = join(__dirname, "..", "..", "..");
const FRONTEND_TREES = ["app", "components", "hooks", "lib"];
const BROWSER_TREES = ["components/", "hooks/"];

const ADMIN = /^firebase-admin(?:\/|$)/;
const FUNCTIONS = /^firebase-functions(?:\/|$)/;

/** The two homes of `httpsCallable` (#647 decision 3). */
const CALLABLE_HOMES = ["lib/firebase/callable.ts", "lib/selfhost/functions-client.ts"];

/**
 * Direct `httpsCallable` callers on 2026-10-05, by path from the repo root, with
 * what each calls. An entry goes when its file moves to `callFunction()`; a new
 * caller is never added.
 */
const CALLABLE_RATCHET: Record<string, string> = {
  "app/(dashboard)/admin/users/page.tsx": "adminDeleteUser, setAdminClaim, setUserOverride",
  "app/(dashboard)/settings/sign-in-security/page.tsx": "setUserPassword",
  "app/(dashboard)/transactions/page.tsx": "matchPartners",
  "components/auth/auth-provider.tsx": "markInviteUsed, submitAccessRequest",
  "components/partners/add-partner-dialog.tsx": "lookupCompany, lookupByVatId",
  "components/settings/billing-plan-card.tsx": "switchTesterPlan",
  "components/settings/billing-plan-comparison.tsx": "switchTesterPlan",
  "components/settings/delete-account-dialog.tsx": "scheduleAccountDeletion",
  "components/settings/delete-account-section.tsx": "cancelAccountDeletion",
  "components/sidebar/transaction-details.tsx": "matchPartners",
  "hooks/use-global-partners.ts": "generatePromotionCandidates",
  "hooks/use-gmail-search-queries.ts": "generateSearchQueriesCallable",
  "hooks/use-gmail-search.ts": "searchGmailCallable",
  "hooks/use-import.ts": "matchPartners",
  "hooks/use-mfa-challenge.ts": "generatePasskeyAuthOptions, verifyPasskeyAuth, verifyBackupCode",
  "hooks/use-mfa.ts": "getMfaStatus",
  "hooks/use-passkeys.ts": "the passkey registration and authentication callables",
  "hooks/use-transaction-matching.ts": "findTransactionMatchesForFile",
  "lib/import/ai-matcher.ts": "matchColumns",
  "lib/operations/category-ops.ts": "assignNoReceiptCategory, matchCategories, learnPartnerCategoryPatterns",
  "lib/operations/file-ops.ts": "matchFilesForPartner, retryFileExtraction",
  "lib/operations/partner-ops.ts": "matchFilesForPartner, learnPartnerPatterns",
};

const CODE = /\.(?:tsx?|jsx?|mjs|cjs)$/;
const TEST = /\.test\.(?:tsx?|jsx?|mjs)$/;
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const USE_CLIENT = /^\s*["']use client["']/;

/** The files the walk reads, by path from the repo root. The disk, or a fixture. */
interface Tree {
  read(path: string): string;
  isFile(path: string): boolean;
}

const disk: Tree = {
  read: (path) => readFileSync(join(repoRoot, path), "utf8"),
  isFile: (path) => existsSync(join(repoRoot, path)) && statSync(join(repoRoot, path)).isFile(),
};

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Runtime specifiers a source imports; type-only imports are left out. */
function runtimeImports(source: string): string[] {
  const code = stripComments(source);
  const specifiers: string[] = [];
  // A clause is names, braces, commas and `*`; anything else ends the match.
  const fromClause = /\b(?:import|export)\s+(type\s+)?([\w\s{},*$]*?)\s*\bfrom\s*["']([^"']+)["']/g;
  for (const [, typeOnly, clause, specifier] of code.matchAll(fromClause)) {
    if (typeOnly) continue;
    const braces = clause.trim().match(/^\{([\s\S]*)\}$/);
    const names = braces ? braces[1].split(",").map((n) => n.trim()).filter(Boolean) : [];
    if (names.length > 0 && names.every((n) => /^type\s/.test(n))) continue;
    specifiers.push(specifier);
  }
  for (const pattern of [
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of code.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

/** The repo file a specifier names, a package, or null (a non-code file). */
function resolve(tree: Tree, from: string, specifier: string): { file: string } | { pkg: string } | null {
  let base: string;
  if (specifier.startsWith("@/")) base = posix.normalize(specifier.slice(2));
  else if (specifier.startsWith(".")) base = posix.join(posix.dirname(from), specifier);
  else return { pkg: specifier };
  const candidates = [base, ...EXTENSIONS.map((e) => base + e), ...EXTENSIONS.map((e) => `${base}/index${e}`)];
  // `./foo.js` written for a `foo.ts` source.
  if (base.endsWith(".js")) candidates.push(base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"));
  const file = candidates.find((c) => tree.isFile(c));
  return file && CODE.test(file) ? { file } : null;
}

type Graph = Map<string, { files: string[]; packages: string[] }>;

function buildGraph(tree: Tree, entries: string[]): Graph {
  const graph: Graph = new Map();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (graph.has(file)) continue;
    const node = { files: [] as string[], packages: [] as string[] };
    graph.set(file, node);
    for (const specifier of runtimeImports(tree.read(file))) {
      const target = resolve(tree, file, specifier);
      if (!target) continue;
      if ("pkg" in target) node.packages.push(target.pkg);
      else {
        node.files.push(target.file);
        queue.push(target.file);
      }
    }
  }
  return graph;
}

/**
 * Where the browser bundle starts: the browser trees and "use client" files.
 * Everything they import is browser code too, which the chains below follow.
 */
function browserRoots(tree: Tree, frontend: string[]): string[] {
  return frontend.filter(
    (f) => BROWSER_TREES.some((t) => f.startsWith(t)) || USE_CLIENT.test(stripComments(tree.read(f))),
  );
}

/** For each root that reaches a package matching `forbidden`, its shortest chain: `root -> ... -> package`. */
function chainsTo(graph: Graph, roots: string[], forbidden: RegExp): string[] {
  const next = new Map<string, string>();
  const queue: string[] = [];
  for (const [file, node] of graph) {
    const pkg = node.packages.find((p) => forbidden.test(p));
    if (pkg) {
      next.set(file, `pkg:${pkg}`);
      queue.push(file);
    }
  }
  const importers = new Map<string, string[]>();
  for (const [file, node] of graph) {
    for (const target of node.files) importers.set(target, [...(importers.get(target) ?? []), file]);
  }
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const importer of importers.get(file) ?? []) {
      if (next.has(importer)) continue;
      next.set(importer, file);
      queue.push(importer);
    }
  }
  const chains: string[] = [];
  for (const root of roots) {
    if (!next.has(root)) continue;
    const steps = [root];
    for (let at = next.get(root)!; ; at = next.get(at)!) {
      if (at.startsWith("pkg:")) {
        steps.push(at.slice(4));
        break;
      }
      steps.push(at);
    }
    chains.push(steps.join(" -> "));
  }
  return chains.sort();
}

/**
 * One chain per place the forbidden package gets in: chains sharing the path
 * from their last frontend file on (one component importing a backend module
 * puts every page above it in breach) collapse to the shortest one.
 */
function onePerEntry(chains: string[]): string[] {
  const shortest = new Map<string, string[]>();
  for (const chain of chains) {
    const steps = chain.split(" -> ");
    let entry = steps.length - 2;
    while (entry > 0 && steps[entry].startsWith("functions/")) entry--;
    const key = steps.slice(entry).join(" -> ");
    const kept = shortest.get(key);
    if (!kept || steps.length < kept.length) shortest.set(key, steps);
  }
  return [...shortest.values()].map((steps) => steps.join(" -> ")).sort();
}

/** The three rules' offenders over a tree. */
function offenders(tree: Tree, frontend: string[], ratchet: Record<string, string>) {
  const graph = buildGraph(tree, frontend);
  const browser = browserRoots(tree, frontend);
  const callers = frontend.filter((f) => /\bhttpsCallable\b/.test(stripComments(tree.read(f))));
  return {
    browserReachesAdmin: onePerEntry(chainsTo(graph, browser, ADMIN)),
    browserReachesFunctions: onePerEntry(chainsTo(graph, browser, FUNCTIONS)),
    serverReachesFunctions: onePerEntry(chainsTo(graph, frontend, FUNCTIONS)),
    newCallableCallers: callers.filter((f) => !CALLABLE_HOMES.includes(f) && !(f in ratchet)),
    staleRatchetEntries: Object.keys(ratchet).filter((f) => !callers.includes(f)),
  };
}

function fixture(files: Record<string, string>): Tree {
  return { read: (path) => files[path], isFile: (path) => path in files };
}

function listFrontend(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "__tests__") walk(path);
      } else if (CODE.test(entry.name) && !TEST.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        out.push(path);
      }
    }
  };
  for (const tree of FRONTEND_TREES) walk(tree);
  return out;
}

const clean = {
  browserReachesAdmin: [],
  browserReachesFunctions: [],
  serverReachesFunctions: [],
  newCallableCallers: [],
  staleRatchetEntries: [],
};

describe("browser code reaches no Firebase server SDK (#688)", () => {
  it("reads the import shapes the walk follows, and skips type-only ones", () => {
    const runtime = [
      `import { a } from "./a";`,
      `import b, { c } from '@/b';`,
      `export { d } from "./d";`,
      `export * from "./e";`,
      `import {\n  i,\n  type I,\n} from "./i";`,
      `import "./f";`,
      `const g = await import("./g");`,
      `const h = require("./h");`,
    ].join("\n");
    expect(runtimeImports(runtime)).toEqual(["./a", "@/b", "./d", "./e", "./i", "./f", "./g", "./h"]);
    const erased = [
      `import type { A } from "./a";`,
      `export type { B } from "./b";`,
      `import { type C, type D } from "./c";`,
      `// import { e } from "./e";`,
      `/* import { f } from "./f"; */`,
    ].join("\n");
    expect(runtimeImports(erased)).toEqual([]);
  });

  it("fails a component that reaches firebase-admin through a backend module", () => {
    const tree = fixture({
      "components/widget.tsx": `import { shared } from "@/functions/src/shared/helper";`,
      "functions/src/shared/helper.ts": `export { shared } from "./inner";`,
      "functions/src/shared/inner.ts": `import { getFirestore } from "firebase-admin/firestore";`,
    });
    expect(offenders(tree, ["components/widget.tsx"], {}).browserReachesAdmin).toEqual([
      "components/widget.tsx -> functions/src/shared/helper.ts -> functions/src/shared/inner.ts -> firebase-admin/firestore",
    ]);
  });

  it("fails client lib that a \"use client\" page reaches, and lets a server page and a route have firebase-admin", () => {
    const tree = fixture({
      "app/client/page.tsx": `"use client";\nimport { load } from "@/lib/loader";`,
      "lib/loader.ts": `import { getAdminDb } from "./admin";`,
      "lib/admin.ts": `import { initializeApp } from "firebase-admin/app";`,
      "app/server/page.tsx": `import { getAdminDb } from "@/lib/admin";`,
      "app/api/x/route.ts": `import { getAdminDb } from "@/lib/admin";`,
    });
    const frontend = ["app/client/page.tsx", "lib/loader.ts", "lib/admin.ts", "app/server/page.tsx", "app/api/x/route.ts"];
    expect(offenders(tree, frontend, {})).toEqual({
      ...clean,
      browserReachesAdmin: ["app/client/page.tsx -> lib/loader.ts -> lib/admin.ts -> firebase-admin/app"],
    });
  });

  it("fails a route that reaches firebase-functions", () => {
    const tree = fixture({
      "app/api/x/route.ts": `import { check } from "@/lib/server-check";`,
      "lib/server-check.ts": `const { HttpsError } = require("firebase-functions/v2/https");`,
    });
    expect(offenders(tree, ["app/api/x/route.ts", "lib/server-check.ts"], {}).serverReachesFunctions).toEqual([
      "lib/server-check.ts -> firebase-functions/v2/https",
    ]);
  });

  it("fails a new httpsCallable outside the wrappers, and a ratchet entry whose file stopped calling it", () => {
    const tree = fixture({
      "lib/firebase/callable.ts": `import { httpsCallable } from "firebase/functions";`,
      "hooks/use-new.ts": `const fn = httpsCallable(functions, "newCallable");`,
      "hooks/use-old.ts": `return callFunction("oldCallable", {}); // was httpsCallable`,
    });
    const result = offenders(tree, ["lib/firebase/callable.ts", "hooks/use-new.ts", "hooks/use-old.ts"], {
      "hooks/use-old.ts": "oldCallable",
    });
    expect(result.newCallableCallers).toEqual(["hooks/use-new.ts"]);
    expect(result.staleRatchetEntries).toEqual(["hooks/use-old.ts"]);
  });

  it("holds on the repo", () => {
    const frontend = listFrontend();
    // The walk sees the backend modules the frontend imports; an empty graph
    // would pass vacuously.
    expect(frontend.length).toBeGreaterThan(500);
    expect(buildGraph(disk, frontend).size).toBeGreaterThan(frontend.length);
    expect(offenders(disk, frontend, CALLABLE_RATCHET)).toEqual(clean);
    for (const home of CALLABLE_HOMES) expect(disk.read(home), home).toMatch(/\bhttpsCallable\b/);
  });
});
