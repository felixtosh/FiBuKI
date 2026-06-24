import admin from 'firebase-admin';
admin.initializeApp({ projectId: 'taxstudio-f12fb' });
const db = admin.firestore();
const { Timestamp } = admin.firestore;

const INTEGRATION_IDS = ['78Trm33SyIe6aZdgmTku', 'H14nlkvHXNWgW2VC5gyL'];
const REASON = "OAuth grant missing 'gmail.readonly' scope — please reconnect.";

for (const id of INTEGRATION_IDS) {
  const ref = db.collection('emailIntegrations').doc(id);
  const snap = await ref.get();
  if (!snap.exists) {
    console.log(`[${id}] not found`);
    continue;
  }
  const before = snap.data();
  await ref.update({
    needsReauth: true,
    lastError: REASON,
    updatedAt: Timestamp.now(),
  });
  console.log(`[${id}] ${before.email}: needsReauth ${before.needsReauth} -> true`);
}
