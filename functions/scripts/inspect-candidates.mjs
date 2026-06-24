import admin from 'firebase-admin';
admin.initializeApp({ projectId: 'taxstudio-f12fb' });
const db = admin.firestore();

const IDS = ['abvtiUFImU2g7ELzng1U', 'A1gloDXzmqTRbU9D7Xkj', 'Im72QvaRHrbDiR9hTC5K'];
for (const id of IDS) {
  const snap = await db.collection('files').doc(id).get();
  if (!snap.exists) { console.log(id, 'NOT FOUND'); continue; }
  const f = snap.data();
  console.log(`\n[${id}] ${f.fileName}`);
  console.log(`  isNotInvoice: ${f.isNotInvoice}`);
  console.log(`  extractionComplete: ${f.extractionComplete}`);
  console.log(`  extractedAmount: ${f.extractedAmount}`);
  console.log(`  extractedPartner: ${f.extractedPartner ?? '-'}`);
  console.log(`  extractedDate: ${f.extractedDate?.toDate?.()?.toISOString?.()?.slice(0,10) ?? '-'}`);
  console.log(`  deletedAt: ${f.deletedAt?.toDate?.()?.toISOString?.() ?? '-'}`);
  console.log(`  partnerId: ${f.partnerId ?? '-'}`);
}
