import admin from 'firebase-admin';
admin.initializeApp({ projectId: 'taxstudio-f12fb' });
const auth = admin.auth();
const db = admin.firestore();

const user = await auth.getUserByEmail('stefan@houseofbandits.at');
const allFiles = await db.collection('files').where('userId', '==', user.uid).get();

const errored = allFiles.docs.filter(d => d.data().extractionError != null);
const stillExtracting = allFiles.docs.filter(d => d.data().extractionComplete === false);

// Files we triggered rescan on (recently re-updated, not the original 130)
// Look at files that had extractionComplete=true with no error and were touched in the last hour
const oneHourAgo = Date.now() - 60 * 60 * 1000;
const recentlyExtracted = allFiles.docs.filter(d => {
  const data = d.data();
  if (data.extractionError) return false;
  if (data.extractionComplete !== true) return false;
  const updated = data.updatedAt?.toMillis?.() ?? 0;
  return updated > oneHourAgo;
});

// Check how many of the recently-extracted have actual extraction data populated
const populated = recentlyExtracted.filter(d => {
  const data = d.data();
  return !!(data.extractedAmount != null || data.extractedPartner || data.extractedDate);
});

const matched = recentlyExtracted.filter(d => d.data().partnerId);

console.log('=== Stefan rescan verification ===');
console.log(`Total files: ${allFiles.size}`);
console.log(`Still errored: ${errored.length}`);
console.log(`Still extracting: ${stillExtracting.length}`);
console.log(`Recently re-extracted successfully: ${recentlyExtracted.length}`);
console.log(`  ...with extracted fields populated: ${populated.length}`);
console.log(`  ...with partner auto-matched: ${matched.length}`);

console.log(`\nSample recently-extracted files:`);
for (const d of recentlyExtracted.slice(0, 5)) {
  const data = d.data();
  console.log(`  ${data.fileName}`);
  console.log(`    amount: ${data.extractedAmount ?? '-'} ${data.extractedCurrency ?? ''}`);
  console.log(`    partner: ${data.extractedPartner ?? '-'}`);
  console.log(`    date: ${data.extractedDate?.toDate?.()?.toISOString?.()?.slice(0,10) ?? '-'}`);
  console.log(`    matched partnerId: ${data.partnerId ?? '-'}`);
}

console.log(`\n=== Remaining 3 errored files ===`);
for (const d of errored) {
  const data = d.data();
  console.log(`  ${data.fileName} (${d.id})`);
  console.log(`    error: ${(data.extractionError ?? '').slice(0, 150)}`);
}
