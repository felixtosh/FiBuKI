/**
 * Browser code reaches no Firebase server SDK, and `httpsCallable` stays inside
 * the wrappers (#688, #647 decision 3). The frontend imports backend modules
 * directly (`@/functions/src/...`); that is safe only while nothing it pulls in,
 * at any depth, imports `firebase-admin` or `firebase-functions`. A comment in a
 * module saying so is not a check, so this walk is.
 *
 * Three rules, over `app`, `components`, `hooks`, `lib`, `design-system`,
 * `i18n` and `next.config.ts`, and everything they import from `functions/src`:
 *
 * 1. **Browser code reaches neither SDK.** Browser code is every file in
 *    `components/`, `hooks/` and `design-system/`, every file that says
 *    "use client", and every file one of those imports, at any depth (client
 *    `lib` is what they reach). A route, a server component in `app/` (no
 *    "use client") and the `lib` reached only from those are server code.
 * 2. **Server code may reach `firebase-admin`** (the app has it), **never
 *    `firebase-functions`** (the app does not install it).
 * 3. **`httpsCallable` lives in the client wrapper and the self-host shim.**
 *    The files in CALLABLE_RATCHET use it directly today, each a pinned number
 *    of times. The list only shrinks: a new file fails, a pinned file using it
 *    more often fails, and so does one using it less often until its number
 *    (or, at zero, its entry) comes down.
 * 4. **The modules in IMPORT_FREE have no runtime import at all.** The tool
 *    definitions are read by the OpenAPI spec, llm.txt and the chat's wrappers
 *    (#691); rules 1 and 2 would still let them reach `firebase-admin` or any
 *    other server-only module, so they are held to type-only imports.
 *
 * Each file is parsed with the TypeScript compiler, so comments and string
 * literals (`"image/*"`) never read as code. The walk follows `import`/`export
 * ... from`, side-effect `import "x"`, `import x = require("x")`, `import("x")`
 * and `require("x")`. A type-only import (`import type`, braces holding only
 * `type` names, `typeof import("x")`) is erased by the compiler, so it is not
 * followed.
 *
 *   npx vitest run --config vitest.selfhost.config.ts src/selfhost/browser-imports.test.ts --pool=forks --maxWorkers=1
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, posix } from "path";
import * as ts from "typescript";

const repoRoot = join(__dirname, "..", "..", "..");
// `design-system` holds "use client" tool results. next-intl loads `i18n/request.ts`
// and Next loads `next.config.ts` without an `@/` import, so both are entries too.
const FRONTEND_TREES = ["app", "components", "hooks", "lib", "design-system", "i18n"];
const FRONTEND_FILES = ["next.config.ts"];
const BROWSER_TREES = ["components/", "hooks/", "design-system/"];

const ADMIN = /^firebase-admin(?:\/|$)/;
const FUNCTIONS = /^firebase-functions(?:\/|$)/;

/** The two homes of `httpsCallable` (#647 decision 3). */
const CALLABLE_HOMES = ["lib/firebase/callable.ts", "lib/selfhost/functions-client.ts"];

/** Shared modules that may import types only (#691), by path from the repo root. */
const IMPORT_FREE = ["functions/src/tools/definitions.ts"];

interface Pinned {
  /** References to `httpsCallable` outside its import. */
  uses: number;
  calls: string;
}

/**
 * Direct `httpsCallable` users on 2026-10-05, by path from the repo root: how
 * often each uses it, and what it calls. An entry shrinks or goes as its file
 * moves to `callFunction()`; a new file is never added.
 */
const CALLABLE_RATCHET: Record<string, Pinned> = {
  "app/(dashboard)/admin/users/page.tsx": {
    uses: 9,
    calls: "listAllUsers, listAdmins, setAdminClaim, setUserOverride, adminDeleteUser, impersonateUser, bulkRetryExtraction",
  },
  "app/(dashboard)/settings/sign-in-security/page.tsx": { uses: 1, calls: "setUserPassword" },
  "app/(dashboard)/transactions/page.tsx": { uses: 1, calls: "matchPartners" },
  "components/auth/auth-provider.tsx": {
    uses: 4,
    calls: "validateRegistration, markInviteUsed, submitAccessRequest, getMfaStatus",
  },
  "components/partners/add-partner-dialog.tsx": { uses: 2, calls: "lookupCompany, lookupByVatId" },
  "components/settings/billing-plan-card.tsx": { uses: 1, calls: "switchTesterPlan" },
  "components/settings/billing-plan-comparison.tsx": { uses: 1, calls: "switchTesterPlan" },
  "components/settings/delete-account-dialog.tsx": { uses: 1, calls: "scheduleAccountDeletion" },
  "components/settings/delete-account-section.tsx": { uses: 1, calls: "cancelAccountDeletion" },
  "components/sidebar/transaction-details.tsx": { uses: 1, calls: "matchPartners" },
  "hooks/use-global-partners.ts": { uses: 1, calls: "generatePromotionCandidates" },
  "hooks/use-gmail-search-queries.ts": { uses: 1, calls: "generateSearchQueriesCallable" },
  "hooks/use-gmail-search.ts": { uses: 1, calls: "searchGmailCallable" },
  "hooks/use-import.ts": { uses: 1, calls: "matchPartners" },
  "hooks/use-mfa-challenge.ts": { uses: 3, calls: "generatePasskeyAuthOptions, verifyPasskeyAuth, verifyBackupCode" },
  "hooks/use-mfa.ts": { uses: 4, calls: "getMfaStatus, generateBackupCodes, verifyBackupCode, updateTotpStatus" },
  "hooks/use-passkeys.ts": {
    uses: 5,
    calls: "generatePasskeyRegistrationOptions, verifyPasskeyRegistration, generatePasskeyAuthOptions, verifyPasskeyAuth, deletePasskey",
  },
  "hooks/use-transaction-matching.ts": { uses: 1, calls: "findTransactionMatchesForFile" },
  "lib/import/ai-matcher.ts": { uses: 1, calls: "matchColumns" },
  "lib/operations/category-ops.ts": {
    uses: 4,
    calls: "assignNoReceiptCategory, matchCategories, learnPartnerCategoryPatterns",
  },
  "lib/operations/file-ops.ts": { uses: 6, calls: "matchFilesForPartner, retryFileExtraction" },
};

const CODE = /\.(?:tsx?|jsx?|mjs|cjs)$/;
const TEST = /\.test\.(?:tsx?|jsx?|mjs)$/;
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** The files the walk reads, by path from the repo root. The disk, or a fixture. */
interface Tree {
  read(path: string): string;
  isFile(path: string): boolean;
}

const disk: Tree = {
  read: (path) => readFileSync(join(repoRoot, path), "utf8"),
  isFile: (path) => existsSync(join(repoRoot, path)) && statSync(join(repoRoot, path)).isFile(),
};

/** What the walk reads from one file. */
interface Scan {
  /** Runtime import specifiers; type-only ones are left out. */
  imports: string[];
  useClient: boolean;
  /** References to `httpsCallable` outside its import. */
  callableUses: number;
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".ts")) return ts.ScriptKind.TS;
  return path.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
}

function scan(source: string, path = "file.tsx"): Scan {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path));
  const imports: string[] = [];
  let callableUses = 0;
  const onlyTypes = (names: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>) =>
    names.length > 0 && names.every((n) => n.isTypeOnly);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly =
        clause?.isTypeOnly || (clause && !clause.name && bindings && ts.isNamedImports(bindings) && onlyTypes(bindings.elements));
      if (!typeOnly && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
      return; // the names it binds are not uses
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const names = node.exportClause;
      const typeOnly = node.isTypeOnly || (names && ts.isNamedExports(names) && onlyTypes(names.elements));
      if (!typeOnly) imports.push(node.moduleSpecifier.text);
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      imports.push(node.moduleReference.expression.text);
    }
    // `import("x")` and `require("x")`; `typeof import("x")` is an ImportType node, not a call.
    if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) {
        imports.push(node.arguments[0].text);
      }
    }
    if (ts.isIdentifier(node) && node.text === "httpsCallable") callableUses++;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { imports, useClient: directives(file).includes("use client"), callableUses };
}

/** The file's directive prologue: the string statements before any other. */
function directives(file: ts.SourceFile): string[] {
  const found: string[] = [];
  for (const statement of file.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    found.push(statement.expression.text);
  }
  return found;
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

type Graph = Map<string, { files: string[]; packages: string[]; scan: Scan }>;

function buildGraph(tree: Tree, entries: string[]): Graph {
  const graph: Graph = new Map();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (graph.has(file)) continue;
    const node = { files: [] as string[], packages: [] as string[], scan: scan(tree.read(file), file) };
    graph.set(file, node);
    for (const specifier of node.scan.imports) {
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
function offenders(tree: Tree, frontend: string[], ratchet: Record<string, Pinned>) {
  const graph = buildGraph(tree, frontend);
  const scanOf = (f: string) => graph.get(f)!.scan;
  // Where the browser bundle starts; everything these import is browser code
  // too, which the chains follow.
  const browser = frontend.filter((f) => BROWSER_TREES.some((t) => f.startsWith(t)) || scanOf(f).useClient);
  const uses = (f: string) => scanOf(f).callableUses;
  return {
    browserReachesAdmin: onePerEntry(chainsTo(graph, browser, ADMIN)),
    browserReachesFunctions: onePerEntry(chainsTo(graph, browser, FUNCTIONS)),
    serverReachesFunctions: onePerEntry(chainsTo(graph, frontend, FUNCTIONS)),
    newCallableUsers: frontend.filter((f) => uses(f) > 0 && !CALLABLE_HOMES.includes(f) && !(f in ratchet)),
    ratchetMismatches: Object.entries(ratchet)
      .filter(([f, pinned]) => uses(f) !== pinned.uses)
      .map(([f, pinned]) => `${f}: pinned ${pinned.uses}, uses ${uses(f)}`),
  };
}

function fixture(files: Record<string, string>): Tree {
  return { read: (path) => files[path], isFile: (path) => path in files };
}

function listFrontend(): string[] {
  const out = [...FRONTEND_FILES];
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
  newCallableUsers: [],
  ratchetMismatches: [],
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
      `import j = require("./j");`,
      `const g = await import("./g");`,
      `const h = require("./h");`,
    ].join("\n");
    expect(scan(runtime).imports).toEqual(["./a", "@/b", "./d", "./e", "./i", "./f", "./j", "./g", "./h"]);
    const erased = [
      `import type { A } from "./a";`,
      `export type { B } from "./b";`,
      `import { type C, type D } from "./c";`,
      `type Db = ReturnType<typeof import("./db")["getAdminDb"]>;`,
      `// import { e } from "./e";`,
      `/* import { f } from "./f"; */`,
    ].join("\n");
    expect(scan(erased).imports).toEqual([]);
  });

  it("is not blinded by a comment opener inside a string", () => {
    const source = [
      `"use client";`,
      `export const accept = "image/*";`,
      `export const load = () => import("./backend");`,
      `/** a later doc comment */`,
      `export const call = httpsCallable(functions, "x");`,
    ].join("\n");
    expect(scan(source)).toEqual({ imports: ["./backend"], useClient: true, callableUses: 1 });
  });

  it("fails a component that reaches firebase-admin through a backend module", () => {
    const tree = fixture({
      "components/widget.tsx": `export const accept = "image/*";\nimport { shared } from "@/functions/src/shared/helper";`,
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

  it("fails a new httpsCallable user, and a pinned file whose uses moved either way", () => {
    const tree = fixture({
      "lib/firebase/callable.ts": `import { httpsCallable } from "firebase/functions";\nhttpsCallable(functions, name);`,
      "hooks/use-new.ts": `const fn = httpsCallable(functions, "newCallable");`,
      "hooks/use-more.ts": `httpsCallable(functions, "a");\nhttpsCallable(functions, "b");`,
      "hooks/use-moved.ts": `return callFunction("oldCallable", {}); // was httpsCallable`,
    });
    const frontend = ["lib/firebase/callable.ts", "hooks/use-new.ts", "hooks/use-more.ts", "hooks/use-moved.ts"];
    const result = offenders(tree, frontend, {
      "hooks/use-more.ts": { uses: 1, calls: "a" },
      "hooks/use-moved.ts": { uses: 1, calls: "oldCallable" },
    });
    expect(result.newCallableUsers).toEqual(["hooks/use-new.ts"]);
    expect(result.ratchetMismatches).toEqual([
      "hooks/use-more.ts: pinned 1, uses 2",
      "hooks/use-moved.ts: pinned 1, uses 0",
    ]);
  });

  it("fails a runtime import in an import-free module, and lets a type-only one pass", () => {
    expect(scan(`import type { PlanFeatureKey } from "../billing/config";`, "d.ts").imports).toEqual([]);
    expect(scan(`import { PLANS } from "../billing/config";`, "d.ts").imports).toEqual(["../billing/config"]);
    expect(scan(`import "firebase-admin";`, "d.ts").imports).toEqual(["firebase-admin"]);
  });

  it("holds on the repo", () => {
    const frontend = listFrontend();
    // The walk sees the backend modules the frontend imports; an empty graph
    // would pass vacuously.
    expect(frontend.length).toBeGreaterThan(500);
    expect(buildGraph(disk, frontend).size).toBeGreaterThan(frontend.length);
    expect(offenders(disk, frontend, CALLABLE_RATCHET)).toEqual(clean);
    for (const home of CALLABLE_HOMES) expect(scan(disk.read(home), home).callableUses, home).toBeGreaterThan(0);
    for (const path of IMPORT_FREE) expect(scan(disk.read(path), path).imports, path).toEqual([]);
  });
});
