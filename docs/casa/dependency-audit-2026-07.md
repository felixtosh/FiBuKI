# Dependency audit — 2026-07-30

Supersedes the June audit (PR #30), which had gone stale: 103 open Dependabot
alerts had accumulated on `main` since.

## Result

| Scope | Before | After |
| --- | --- | --- |
| Root, production deps | 2 critical, 15 high, 11 moderate, 2 low | **0 critical, 0 high, 8 moderate** |
| Root, all scopes | 4 critical, 16 high, 11 moderate, 2 low | 0 critical, 15 high (dev-only), 8 moderate |
| Functions, production deps | 1 critical, 11 high, 13 moderate, 1 low | **0 critical**, 8 high, 7 moderate |

**All four criticals are closed.** The root production surface — what actually
serves fibuki.com — has no remaining high or critical findings.

## What changed

**`next` 16.2.9 → ^16.2.11.** A patch bump closing six advisories, two of them
material for an authenticated app: a middleware/proxy bypass in App Router, and
SSRF via attacker-controlled rewrites. Also a cache-confusion issue, an Image
Optimization DoS, an unauthenticated Server Function endpoint disclosure, and a
Server Actions DoS. Confirmed afterwards that `next` carries no advisory of its own
— it is now flagged only *via* its dependencies.

**`postcss` → ^8.5.25, plus an override.** The direct dependency was `^8.5.8`, but
bumping it was not enough: `next` bundles a nested `postcss@8.4.31`, still inside
the vulnerable `<=8.5.17` range. Verified in the lockfile that the override
collapses both copies to a single patched 8.5.25.

**`sharp` override to ^0.35.3**, for the inherited libvips findings. Transitive, so
an override is the right lever.

**`eslint-config-next` moved from `dependencies` to `devDependencies`.** A packaging
mistake, not a version issue: lint tooling was declared as a runtime dependency, so
the whole eslint/typescript-eslint cluster counted against the production surface
and shipped in production installs. `eslint` itself was already correctly in
devDependencies.

**Functions: `npm audit fix` plus overrides** on `gaxios`, `gcp-metadata` and
`zip-stream` to their patched releases. Closed the `basic-ftp` critical (path
traversal in `downloadToDir`) and the `@xmldom/xmldom`, `fast-xml-parser`, `ws`,
`@grpc/grpc-js`, `lodash`, `mailparser`, `linkify-it`, `path-to-regexp` and
`form-data` findings.

## Deliberately NOT done, and why

**`npm audit fix --force` was never run.** Its proposals here are actively
destructive: it recommends `next@9.3.3` (seven majors backward, from 16.x) and
`firebase-admin@10.3.0` (three majors backward, from 13.x). Both would open far
more than they close. Any automated remediation of these lockfiles must skip
`--force`.

**`archiver` 7 → 8 was attempted and reverted.** It genuinely closes four highs
(`archiver`, `archiver-utils`, `readdir-glob`, `zip-stream`), but `@types/archiver`
is still `^7` and archiver 8 bundles no types of its own — so the build would
typecheck v7 definitions against a v8 runtime. The zip paths
(`bmd-export/processBmdExportQueue.ts`, `user-export/processUserExportQueue.ts`) use
`append`/`finalize` and have no test coverage, so a silent API drift would not be
caught. Dependabot PR #35 is the right vehicle: bump both together and smoke-test an
actual export.

**`glob` / `google-gax` / `rimraf` / `minimatch` / `brace-expansion` in functions.**
Transitive under `firebase-admin` and Google's own client libraries. npm offers no
legitimate remediation — only the `firebase-admin@10.3.0` downgrade above. These
close when Google ships updated dependencies. Accepted, and they are not reachable
from any request path we control: they are internals of the Google SDK's own
transport and file handling.

## Remaining moderates

Eight in root, seven in functions, all transitive and none with a non-destructive
fix. Re-check when the next `firebase-admin` and `next` minors land.

## Verification

Lockfiles were updated with `--package-lock-only`; CI (`App (lint + typecheck +
build)`, `Cloud Functions (build + test)`, both self-host suites and the Firestore
parity suite) is the gate on whether the resolved tree actually builds and passes.
