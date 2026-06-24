import admin from 'firebase-admin';
admin.initializeApp({ projectId: 'taxstudio-f12fb' });
const db = admin.firestore();

const PARTNER_ID = 'fDHhZY1EZ5KwCY3qHDu8';
const snap = await db.collection('partners').doc(PARTNER_ID).get();
if (!snap.exists) {
  console.log('partner not found in partners collection, trying globalPartners');
  const g = await db.collection('globalPartners').doc(PARTNER_ID).get();
  console.log('globalPartners exists:', g.exists);
  if (g.exists) console.log(g.data());
} else {
  const p = snap.data();
  console.log('partner doc fields:', Object.keys(p).join(', '));
  console.log({
    name: p.name,
    officialName: p.officialName,
    aliases: p.aliases,
    website: p.website,
    domains: p.domains,
    emailPatterns: p.emailPatterns,
  });
}
