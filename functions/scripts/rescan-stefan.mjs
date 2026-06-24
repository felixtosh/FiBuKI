import admin from 'firebase-admin';

admin.initializeApp({ projectId: 'taxstudio-f12fb' });
const auth = admin.auth();
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;

const TARGET_EMAIL = process.argv[2] || 'stefan@houseofbandits.at';

const targetUser = await auth.getUserByEmail(TARGET_EMAIL);
console.log(`Target: ${targetUser.email} (${targetUser.uid})\n`);

const allFiles = await db.collection('files').where('userId', '==', targetUser.uid).get();
const errored = allFiles.docs.filter((d) => d.data().extractionError != null && !d.data().deletedAt);
console.log(`Errored files: ${errored.length}\n`);

if (errored.length === 0) {
  console.log('Nothing to rescan.');
  process.exit(0);
}

// Strategy: re-trigger the existing `extractFileDataOnUndelete` Cloud Function
// by soft-deleting then immediately undeleting each file. The trigger fires
// when `deletedAt` flips from non-null to null AND `extractionComplete` is
// false — so we reset extraction state in the same write.
//
// Done sequentially with a small delay so the trigger's onDocumentUpdated
// event picks up each cleanly. Concurrency on writes is fine, but Firestore
// can collapse rapid sequential updates to the same doc into a single change
// event — so we do them as TWO discrete updates per file.

const RESET_DELAY_MS = 250; // small gap between delete + undelete

let processed = 0;
let writeFailed = 0;
const writeFailures = [];

for (const doc of errored) {
  const fileId = doc.id;
  const fileName = doc.data().fileName;
  try {
    // Step 1: soft-delete + reset extraction state
    await doc.ref.update({
      deletedAt: Timestamp.now(),
      extractionComplete: false,
      extractionError: null,
      isNotInvoice: null,
      notInvoiceReason: null,
      partnerMatchComplete: false,
      partnerMatchedAt: null,
      partnerSuggestions: [],
      transactionMatchComplete: false,
      transactionMatchedAt: null,
      transactionSuggestions: [],
      updatedAt: FieldValue.serverTimestamp(),
    });
    await new Promise((r) => setTimeout(r, RESET_DELAY_MS));
    // Step 2: undelete — triggers extractFileDataOnUndelete
    await doc.ref.update({
      deletedAt: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    processed++;
    process.stdout.write(`  ✓ ${fileName} (${fileId})\n`);
  } catch (err) {
    writeFailed++;
    writeFailures.push({ fileId, fileName, error: err.message });
    process.stdout.write(`  ✗ ${fileName} (${fileId}) — ${err.message}\n`);
  }
}

console.log(`\n========================================`);
console.log(`Triggered rescan on ${processed} / ${errored.length} files.`);
console.log(`Write failures: ${writeFailed}`);
if (writeFailures.length > 0) {
  console.log(JSON.stringify(writeFailures.slice(0, 3), null, 2));
}
console.log(`\nExtraction now runs in the background via extractFileDataOnUndelete.`);
console.log(`Watch the new errors clear over the next few minutes:`);
console.log(`  node scripts/inspect-stefan.mjs`);
