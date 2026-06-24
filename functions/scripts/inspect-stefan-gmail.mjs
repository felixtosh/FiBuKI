import admin from 'firebase-admin';
admin.initializeApp({ projectId: 'taxstudio-f12fb' });
const auth = admin.auth();
const db = admin.firestore();

const user = await auth.getUserByEmail('stefan@houseofbandits.at');

const integrations = await db.collection('emailIntegrations')
  .where('userId', '==', user.uid)
  .get();

console.log(`=== Email integrations for ${user.email} ===`);
for (const doc of integrations.docs) {
  const d = doc.data();
  console.log(`\n[${doc.id}]`);
  console.log(`  email: ${d.email}`);
  console.log(`  isActive: ${d.isActive}`);
  console.log(`  needsReauth: ${d.needsReauth}`);
  console.log(`  tokenExpiresAt: ${d.tokenExpiresAt?.toDate?.()?.toISOString?.()}`);
  console.log(`  lastError: ${d.lastError ?? '-'}`);
  console.log(`  createdAt: ${d.createdAt?.toDate?.()?.toISOString?.()}`);
  console.log(`  disconnectedAt: ${d.disconnectedAt?.toDate?.()?.toISOString?.() ?? '-'}`);

  // Check token doc
  const tokenSnap = await db.collection('emailTokens').doc(doc.id).get();
  if (tokenSnap.exists) {
    const t = tokenSnap.data();
    console.log(`  token doc fields: ${Object.keys(t).join(', ')}`);
    console.log(`  token expiresAt: ${t.expiresAt?.toDate?.()?.toISOString?.()}`);
    // Check if scope is stored
    if (t.scope) console.log(`  token scope: ${t.scope}`);
    if (t.scopes) console.log(`  token scopes: ${JSON.stringify(t.scopes)}`);
  } else {
    console.log(`  token doc: MISSING`);
  }
}

// Also check recent sync queue
const recentQueue = await db.collection('gmailSyncQueue')
  .where('userId', '==', user.uid)
  .orderBy('createdAt', 'desc')
  .limit(5)
  .get();

console.log(`\n=== Recent sync queue items (last 5) ===`);
for (const doc of recentQueue.docs) {
  const d = doc.data();
  console.log(`[${doc.id}] status=${d.status} type=${d.type} integration=${d.integrationId?.slice(0,8)} created=${d.createdAt?.toDate?.()?.toISOString?.()}`);
  if (d.error) console.log(`  error: ${(d.error || '').slice(0, 200)}`);
}
