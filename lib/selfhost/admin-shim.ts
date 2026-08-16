/**
 * Self-host replacement for `lib/firebase/admin.ts`.
 *
 * Aliased at build time by next.config.ts when FIBUKI_BACKEND=selfhost, the same way
 * the client SDKs and the server-auth helper are swapped. The ~35 modules that call
 * `getAdminDb()` are unmodified and never learn which backend answers.
 *
 * ## Why this has to exist
 *
 * `lib/firebase/admin.ts` initialises the Firebase Admin SDK, which authenticates
 * with Google Application Default Credentials. A host outside GCP has none, so every
 * one of those modules fails with
 *
 *   Could not load the default credentials
 *
 * That is not one broken page. It is the entire server-side data surface of
 * fibuki-web: the chat agent's tools, the public invoice share page, precision
 * search, the worker endpoint, Gmail, and the auth routes.
 *
 * ## Why it talks to Postgres directly
 *
 * When the server-auth shim was written, fibuki-web was deliberately denied database
 * access: needing it purely to verify a JWT was a poor trade for handing the web
 * container a data plane. With 20+ reachable routes needing real document IO, that
 * trade inverts.
 *
 * The alternative — proxying to fibuki-api over HTTP — sounds more conservative but
 * is worse. It would mean exposing a GENERIC, network-reachable data-access endpoint
 * capable of running arbitrary queries on any collection, which is a weaker position
 * than a database role that RLS still scopes by `app.tenant_id`. And fibuki-web's
 * server side is not a lower trust tier: it already holds the Gemini, Anthropic and
 * Gmail OAuth secrets.
 *
 * The browser still never touches the database — these are server-only modules — so
 * the rule in docs/rewrite-goals.md ("we own the API layer; the client never touches
 * the DB") holds. What changes is that fibuki-web's SERVER half is now, correctly, a
 * peer of fibuki-api rather than a client of it.
 *
 * Reuses functions/src/selfhost/{firestore,storage}-shim rather than reimplementing
 * them, so both containers resolve documents through identical code — including RLS
 * arming, tenant scoping and change notification. A second implementation would be a
 * second set of bugs, and the two would drift.
 */

import { getFirestore } from "../../functions/src/selfhost/firestore-shim";
import { getStorage } from "../../functions/src/selfhost/storage-shim";
import { useDurableTriggerQueue } from "../../functions/src/selfhost/trigger-queue";

/**
 * Trigger delivery for this container.
 *
 * Firestore triggers are dispatched by an in-process bus that only fibuki-api
 * drains. This module is loaded in fibuki-web and nowhere else, which makes it
 * the one unambiguous place to say "writes from this process cannot be
 * dispatched locally". Before this, they emitted onto a bus with no listeners:
 * every trigger whose originating write came from a web route silently never
 * ran, and the same call site worked correctly from fibuki-api and under test.
 *
 * Now those writes append to `trigger_events` in the same transaction, and
 * fibuki-api's drain (functions/src/selfhost/trigger-queue-drain.ts) delivers
 * them. Module scope on purpose — it must be true before the first write, and
 * every route reaches document IO through getAdminDb() below.
 */
useDurableTriggerQueue();

/**
 * The Firestore-shaped handle, backed by Postgres.
 *
 * Returned as `unknown`-widened structural types at the call sites, exactly as the
 * Firebase version is: callers use `.collection()`, `.doc()`, `.batch()` and friends,
 * all of which the shim implements. Typed loosely here on purpose — pinning
 * firebase-admin's `Firestore` would reintroduce the dependency this file exists to
 * remove.
 */
export function getAdminDb(): ReturnType<typeof getFirestore> {
  return getFirestore();
}

export function getAdminStorage(): ReturnType<typeof getStorage> {
  return getStorage();
}

/** Default bucket. The shim ignores the name, as the self-host stack has exactly one. */
export function getAdminBucket() {
  return getStorage().bucket();
}

/**
 * There is no Firebase App to initialise.
 *
 * Kept because five call sites import it, and throwing here would break them for no
 * benefit — nothing self-host does with the return value is meaningful, and the
 * modules that ask for it only pass it to other Firebase helpers that are themselves
 * shimmed. Returning a marker object keeps those paths alive and makes a genuine
 * misuse (someone reaching into App internals) fail loudly at the property access
 * rather than silently succeeding against a half-real object.
 */
export function getAdminApp(): { name: string; options: Record<string, never> } {
  return { name: "fibuki-selfhost", options: {} };
}

/**
 * Build a download URL for a stored object.
 *
 * The Firebase version returns a firebasestorage.googleapis.com URL carrying an
 * access token. Self-host serves its own objects, so this must emit the host's
 * `/__storage/download/<per-segment-encoded-path>` shape instead.
 *
 * DELEGATED rather than reimplemented, deliberately. The URL has three details that
 * are easy to get subtly wrong and silently broken: the path is encoded per segment
 * (so `/` survives), the base comes from FIBUKI_PUBLIC_URL (empty means root-relative
 * for same-origin deployments, and it must not throw when unset), and the `?token=`
 * query is reserved for the client shim's own id-token rather than this path. A
 * backend-written link and a web-written link for the same object must be byte
 * identical, because both are resolved by one handler — importing the single
 * implementation is the only way to guarantee that stays true.
 *
 * Signature matches the Firebase helper; callers pass positionally.
 */
export { buildDownloadUrl as getFirebaseStorageDownloadUrl } from "../../functions/src/selfhost/buildDownloadUrl-shim";
