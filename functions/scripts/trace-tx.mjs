import admin from 'firebase-admin';
admin.initializeApp({ projectId: 'taxstudio-f12fb' });
const db = admin.firestore();
const auth = admin.auth();

const TXN_ID = 'K6xmJHrOHOkh2HbVzB5e';
const tx = (await db.collection('transactions').doc(TXN_ID).get()).data();
console.log(`tx: name=${tx.name} partner=${tx.partner ?? '-'} partnerId=${tx.partnerId ?? '-'} amount=${tx.amount} date=${tx.date?.toDate?.()?.toISOString?.()?.slice(0,10)} fileIds=${JSON.stringify(tx.fileIds ?? [])}`);

if (tx.partnerId) {
  const p = (await db.collection('partners').doc(tx.partnerId).get()).data();
  console.log(`\npartner: ${p?.name} website=${p?.website ?? '-'} aliases=${JSON.stringify(p?.aliases ?? [])}`);
  console.log(`  emailDomains: ${JSON.stringify(p?.emailDomains ?? [])}`);
  console.log(`  learnedPatterns: ${JSON.stringify(p?.learnedPatterns ?? null)?.slice?.(0, 400)}`);
  console.log(`  fileSourcePatterns: ${JSON.stringify(p?.fileSourcePatterns ?? null)?.slice?.(0, 400)}`);
}

// Look at recent function logs for this transaction
console.log('\n--- gcloud logging will be slow; skipping. Check Cloud Logging directly if needed.');
