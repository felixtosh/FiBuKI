import admin from 'firebase-admin';
admin.initializeApp({ projectId: 'taxstudio-f12fb' });
const auth = admin.auth();
const db = admin.firestore();

const user = await auth.getUserByEmail('stefan@houseofbandits.at');
const integrations = await db.collection('emailIntegrations').where('userId','==',user.uid).get();

console.log('=== Integration sync state ===');
for (const doc of integrations.docs) {
  const d = doc.data();
  console.log(`\n[${doc.id}] ${d.email}`);
  console.log(`  isActive=${d.isActive} needsReauth=${d.needsReauth} isPaused=${d.isPaused ?? false}`);
  console.log(`  initialSyncStartedAt: ${d.initialSyncStartedAt?.toDate?.()?.toISOString?.() ?? '-'}`);
  console.log(`  initialSyncComplete:  ${d.initialSyncComplete ?? false}`);
  console.log(`  lastSyncError: ${(d.lastSyncError ?? '').slice(0, 200) || '-'}`);
  console.log(`  lastSyncDateRange.from: ${d.lastSyncDateRange?.from?.toDate?.()?.toISOString?.() ?? '-'}`);
  console.log(`  lastSyncDateRange.to:   ${d.lastSyncDateRange?.to?.toDate?.()?.toISOString?.() ?? '-'}`);
  console.log(`  ALL fields: ${Object.keys(d).join(', ')}`);
}

// All queue items per integration (across all time)
console.log('\n=== gmailSyncQueue per integration ===');
const allQ = await db.collection('gmailSyncQueue').where('userId','==',user.uid).get();
const byInt = {};
for (const d of allQ.docs) {
  const data = d.data();
  byInt[data.integrationId] = byInt[data.integrationId] || [];
  byInt[data.integrationId].push({
    id: d.id,
    status: data.status,
    type: data.type,
    created: data.createdAt?.toDate?.()?.toISOString?.(),
    error: (data.error || '').slice(0, 200),
    emailsProcessed: data.emailsProcessed,
    filesCreated: data.filesCreated,
  });
}
for (const [intId, items] of Object.entries(byInt)) {
  console.log(`\n  integration ${intId}: ${items.length} queue items`);
  for (const item of items.slice(-5)) {
    console.log(`    [${item.id}] ${item.status} type=${item.type} created=${item.created} emails=${item.emailsProcessed} files=${item.filesCreated}`);
    if (item.error) console.log(`       error: ${item.error}`);
  }
}
