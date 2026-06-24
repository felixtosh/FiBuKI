import admin from 'firebase-admin';
admin.initializeApp({ projectId: 'taxstudio-f12fb' });
const auth = admin.auth();
const db = admin.firestore();

const user = await auth.getUserByEmail('stefan@houseofbandits.at');

// Include INACTIVE integrations too
const integrations = await db.collection('emailIntegrations')
  .where('userId', '==', user.uid)
  .get();

console.log(`=== ALL email integrations for ${user.email} (${integrations.size}) ===`);
for (const doc of integrations.docs) {
  const d = doc.data();
  console.log(`\n[${doc.id}] ${d.email}`);
  console.log(`  isActive: ${d.isActive}  needsReauth: ${d.needsReauth}`);
  console.log(`  created: ${d.createdAt?.toDate?.()?.toISOString?.()}`);
  console.log(`  disconnectedAt: ${d.disconnectedAt?.toDate?.()?.toISOString?.() ?? '-'}`);
  console.log(`  lastError: ${(d.lastError ?? '').slice(0, 200)}`);

  // Check token + introspect via Google
  const tokenSnap = await db.collection('emailTokens').doc(doc.id).get();
  if (!tokenSnap.exists) {
    console.log(`  TOKEN DOC: MISSING`);
    continue;
  }
  const t = tokenSnap.data();
  console.log(`  token expiresAt: ${t.expiresAt?.toDate?.()?.toISOString?.()}`);

  // Note: tokens are encrypted in storage. Decrypting locally requires the secret.
  console.log(`  accessToken encrypted: ${typeof t.accessToken === 'object' || (t.accessToken?.startsWith?.('enc:') || t.accessToken?.length > 200)}`);
}

// Sync queue WITHOUT orderBy (no index needed)
const queueAll = await db.collection('gmailSyncQueue')
  .where('userId', '==', user.uid)
  .get();
console.log(`\n=== gmailSyncQueue (${queueAll.size}) ===`);
const sorted = queueAll.docs.sort((a,b) => (b.data().createdAt?.toMillis?.()??0) - (a.data().createdAt?.toMillis?.()??0));
for (const doc of sorted.slice(0, 8)) {
  const d = doc.data();
  console.log(`[${doc.id}] status=${d.status} type=${d.type} integ=${d.integrationId?.slice(0,8)} created=${d.createdAt?.toDate?.()?.toISOString?.()}`);
  if (d.error) console.log(`  error: ${(d.error||'').slice(0, 300)}`);
  if (d.startedAt) console.log(`  startedAt: ${d.startedAt?.toDate?.()?.toISOString?.()}`);
  if (d.completedAt) console.log(`  completedAt: ${d.completedAt?.toDate?.()?.toISOString?.()}`);
}
