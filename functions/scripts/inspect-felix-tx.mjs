import admin from 'firebase-admin';
admin.initializeApp({ projectId: 'taxstudio-f12fb' });
const auth = admin.auth();
const db = admin.firestore();

const TXN_ID = 'C2GsFftSLROQBSEKud4Z';
const USER_EMAIL = 'felix@i7v6.com';

const user = await auth.getUserByEmail(USER_EMAIL);
console.log(`User: ${user.email} (${user.uid})`);

// 1) Transaction owner check
const txSnap = await db.collection('transactions').doc(TXN_ID).get();
if (!txSnap.exists) {
  console.log(`\nTransaction ${TXN_ID} NOT FOUND`);
} else {
  const tx = txSnap.data();
  console.log(`\nTransaction ${TXN_ID}:`);
  console.log(`  userId match: ${tx.userId === user.uid}`);
  console.log(`  name: ${tx.name}`);
  console.log(`  partner: ${tx.partner ?? '-'}`);
  console.log(`  partnerId: ${tx.partnerId ?? '-'}`);
  console.log(`  amount: ${tx.amount}`);
  console.log(`  date: ${tx.date?.toDate?.()?.toISOString?.()?.slice(0,10) ?? '-'}`);
  console.log(`  fileIds: ${JSON.stringify(tx.fileIds ?? [])}`);
  console.log(`  noReceiptCategoryId: ${tx.noReceiptCategoryId ?? '-'}`);
}

// 2) Felix's Gmail integrations
const integrations = await db.collection('emailIntegrations')
  .where('userId', '==', user.uid)
  .get();
console.log(`\n=== ${user.email}'s email integrations (${integrations.size}) ===`);
for (const doc of integrations.docs) {
  const d = doc.data();
  console.log(`\n[${doc.id}] ${d.email} (${d.provider})`);
  console.log(`  isActive: ${d.isActive}  needsReauth: ${d.needsReauth}`);
  console.log(`  initialSyncComplete: ${d.initialSyncComplete ?? false}`);
  console.log(`  lastError: ${(d.lastError ?? '').slice(0, 150) || '-'}`);
  console.log(`  lastSyncError: ${(d.lastSyncError ?? '').slice(0, 150) || '-'}`);
  console.log(`  tokenExpiresAt: ${d.tokenExpiresAt?.toDate?.()?.toISOString?.()}`);
}

// 3) What the workflow's gating condition computes
const activeIntegrationIds = integrations.docs
  .filter(d => {
    const data = d.data();
    return data.provider === 'gmail' && data.isActive === true && !data.needsReauth;
  })
  .map(d => d.id);
console.log(`\nActive non-reauth Gmail integration IDs: ${JSON.stringify(activeIntegrationIds)}`);

// 4) Query that would be sent to Gmail
if (txSnap.exists) {
  const tx = txSnap.data();
  const query = (tx.partner || tx.name || '').trim();
  console.log(`Computed Gmail query: ${JSON.stringify(query)}`);
}
