/**
 * READ-ONLY drift check: how much has live production Firestore changed since the
 * migration snapshot was taken?
 *
 * The cutover to fibuki.com is a DNS flip onto the migrated copy. Anything written to
 * production after the snapshot and not re-migrated is silently lost at that moment,
 * with no error and no obvious symptom until a user notices their data is missing. So
 * the flip is only safe once this reports zero, or once a fresh export/import/verify
 * has been run inside a write freeze.
 *
 * Counts only. Writes nothing. Safe to run against production at any time.
 *
 *   KEY=/path/to/service-account.json node scripts/drift-check.mjs
 *   KEY=... CUT=2026-07-29T00:00:00Z node scripts/drift-check.mjs
 */

import admin from "firebase-admin";
import { readFileSync } from "node:fs";

const keyPath = process.env.KEY;
if (!keyPath) {
  console.error("KEY=/path/to/service-account.json is required");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(keyPath, "utf8"))),
});
const db = admin.firestore();

// Default matches the newest auth session found in the migrated copy, which is the
// best available marker for when the export ran.
const CUT = new Date(process.env.CUT || "2026-07-29T00:00:00Z");
const COLLECTIONS = [
  "transactions",
  "files",
  "sources",
  "partners",
  "invoices",
  "users",
  "subscriptions",
];

console.log(`Drift since ${CUT.toISOString()} (live production Firestore)\n`);

let drift = 0;
for (const name of COLLECTIONS) {
  const total = (await db.collection(name).count().get()).data().count;

  // Not every collection carries updatedAt; report rather than assume zero, because
  // "no updatedAt field" and "nothing changed" must not look the same here.
  let since = null;
  for (const field of ["updatedAt", "createdAt"]) {
    try {
      since = (await db.collection(name).where(field, ">", CUT).count().get()).data()
        .count;
      break;
    } catch {
      /* field absent or unindexed; try the next one */
    }
  }

  if (since !== null) drift += since;
  console.log(
    `  ${name.padEnd(14)} total=${String(total).padStart(6)}   changed_since_cut=${
      since === null ? "UNKNOWN (no timestamp field)" : since
    }`,
  );
}

console.log(
  `\n  TOTAL DRIFT: ${drift}` +
    (drift === 0
      ? "  — a DNS flip would lose nothing."
      : "  — these writes exist ONLY in production. Re-migrate before flipping."),
);
process.exit(0);
