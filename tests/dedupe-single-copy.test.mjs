/**
 * Duplicate detection has one formula, on the server (functions/src/imports/dedupe.ts). It used to exist
 * in several browser and route copies that could drift apart; these checks fail if one comes back.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(path);
  }
  return out;
}

const clientFiles = ["app", "components", "hooks", "lib"].flatMap((d) => sourceFiles(d));

test("the client IBAN helper module has no hashing and no duplicate queries", () => {
  const src = readFileSync("lib/import/deduplication.ts", "utf8");
  assert.doesNotMatch(src, /generateDedupeHash/);
  assert.doesNotMatch(src, /crypto\.subtle/);
  assert.doesNotMatch(src, /firebase\/firestore/);
});

test("nothing in the app imports a client-side dedupe hash", () => {
  const offenders = clientFiles.filter((f) =>
    /import\s*\{[^}]*generateDedupeHash[^}]*\}\s*from\s*["']@\/lib\/import\/deduplication["']/.test(readFileSync(f, "utf8"))
  );
  assert.deepEqual(offenders, []);
});

test("hooks do not compute or send a dedupeHash", () => {
  const offenders = clientFiles
    .filter((f) => f.startsWith("hooks/"))
    .filter((f) => /\bdedupeHash\s*:/.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, []);
});

test("the formula is defined once in the functions", () => {
  const definers = sourceFiles("functions/src").filter((f) => /function computeDedupeHash\b/.test(readFileSync(f, "utf8")));
  assert.deepEqual(definers, [join("functions", "src", "imports", "dedupe.ts")]);
});

test("the TrueLayer routes use that one formula", () => {
  for (const f of ["app/api/truelayer/sync/route.ts", "app/api/truelayer/accounts/route.ts", "lib/truelayer/transform.ts"]) {
    assert.match(readFileSync(f, "utf8"), /from "@\/functions\/src\/imports\/dedupe"/, f);
  }
});
