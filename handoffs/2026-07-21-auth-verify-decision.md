# Auth findings: unverified JWT in API routes — FIXED

**Status:** Investigation 2026-07-21; Stefan approved the fix same day.
`lib/auth/get-server-user.ts` now verifies tokens with Firebase Admin
`verifyIdToken` (uid and admin claim both come from the verified token).
Verified consumers: web UI and extension send real ID tokens; the CLI's
device-flow API key only hits `/api/mcp/*` proxy routes, which forward auth
to the Cloud Function and never used this helper. No selfhost branch point
needed: the shims only alias client `firebase/*` for the browser bundle, and
the Next API routes are not part of the selfhost data plane.

## Finding: `getServerUserIdWithFallback` is an auth bypass in the Next.js API layer

`lib/auth/get-server-user.ts` decodes the Bearer JWT **without signature
verification** and returns `payload.user_id || payload.sub`. Anyone can mint a
three-part token with an arbitrary `user_id` — no Firebase account needed.
`isServerUserAdmin` reads `payload.admin === true` from the same unverified
payload, so the admin gate is equally forgeable.

The "fallback" in the name is historical: the original version fell back to a
mock `dev-user-123` in development. That fallback was already removed; the
unverified decode was always a "for now" placeholder that shipped.

## Blast radius (44 routes call it)

- **~23 routes do direct Firestore/Storage access via Admin SDK** (bypasses
  security rules) keyed on the forged userId → full cross-tenant read/write.
  Includes `chat` (agent with write tools), `worker`, all `banking/*`,
  most `gmail/*`, `browser/upload`, `sources/[id]/disconnect`,
  `precision-search/*`, `plaid/exchange`, `finapi/callback`,
  `mail/imap/connect`, `auth/device/approve`.
- **~15 routes use the server-side client SDK** (`getServerDb` /
  `firebase/firestore`) or lib helpers — same problem, subject only to
  whatever `firestore.rules` allows an unauthenticated server principal.
  Includes `email-inbound/*`, `truelayer/*`, `gmail/analyze-email`,
  `sources/delete-orphans`.
- **6 pure proxy routes** (`matching/score-files`, `reports/*`,
  `finanzonline/*`, `browser/convert-html`) forward the raw token to Cloud
  Functions, which verify it themselves — a forged token fails downstream.
  These are safe; the decoded userId is only a pre-check.
- **2 admin routes** (`admin/tests`, `admin/cleanup-orphaned-transactions`)
  are gated by the forgeable `admin` claim.

## The fix (implemented)

`firebase-admin` is already initialized with the service account in prod
(`lib/firebase/admin.ts`) and points at the auth emulator in dev
(`FIREBASE_AUTH_EMULATOR_HOST` is set at module load). So a drop-in exists:

```ts
import { getAuth } from "firebase-admin/auth";
const decoded = await getAuth(getAdminApp()).verifyIdToken(token);
return decoded.uid; // and decoded.admin === true for the admin check
```

One helper change fixes all 44 routes; no per-route edits needed. Caveats:

- Self-host: `functions/src/selfhost/auth-shim.ts` deliberately throws on
  `verifyIdToken` (OIDC layer owns auth there). The helper needs the same
  branch point so the selfhost spike keeps working.
- Emulator tokens verify fine when the env var is set (already is).
- Adds one Google cert fetch (cached by the SDK) per cold start — negligible.

## Other decisions (Stefan approved going ahead, 2026-07-21)

- **Extension tests:** wire them up and add a CI job (in progress).
- **Quality noise ×166:** switch CodeQL suite `security-and-quality` →
  `security-extended` — keeps/extends the security queries, drops the
  quality-only ones; a dedicated cleanup round can still happen later
  (in progress).

## Still pending externally

- **Felix:** `firebase deploy --only functions` for ROUND-2 fixes
  (lookupCompany, geminiSearchHelper, precisionSearchQueue, gmailSyncQueue);
  `@fibukiapp/cli` 0.1.1 npm publish.
- **Chrome Web Store:** manifest 0.0.3 ships on next published GitHub Release.
