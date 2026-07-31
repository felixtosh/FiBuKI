/**
 * Self-host replacement for the `firebase-admin/firestore` module specifier.
 *
 * Roughly twenty modules under app/ import from that specifier directly rather than
 * through `@/lib/firebase/admin` — almost entirely for the `Timestamp` and
 * `FieldValue` value classes (Timestamp.now alone appears 228 times), plus
 * `getFirestore` in a couple of places.
 *
 * Those classes need no credentials, so leaving the specifier unaliased "works". It
 * is still wrong, for a reason that only bites at runtime: the shim serialises values
 * by checking `instanceof Timestamp` against the copy of @google-cloud/firestore it
 * imported. If app code constructs a Timestamp from a SECOND copy — the one nested
 * under firebase-admin — those checks fail and timestamps round-trip as opaque
 * objects. Whether that happens depends on npm hoisting, i.e. on tree layout rather
 * than on anything in this repo, which is not a property worth depending on.
 *
 * Aliasing makes the web build resolve exactly what the API build
 * (vitest.selfhost.config.ts and the api image) already resolves, so both containers
 * and the test suite agree on one Timestamp class. Without this the tests would
 * exercise a module graph that production does not have — the tests alias this
 * specifier, so a mismatch here would be invisible to them.
 *
 * A re-export rather than pointing the alias straight at functions/src/selfhost, so
 * next.config.ts's shim map stays uniform (every entry names a file in lib/selfhost)
 * and this note has somewhere to live.
 */

export * from "../../functions/src/selfhost/firestore-shim";
