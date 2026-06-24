import admin from 'firebase-admin';
admin.initializeApp({ projectId: 'taxstudio-f12fb' });
const auth = admin.auth();
const db = admin.firestore();

const user = await auth.getUserByEmail('stefan@houseofbandits.at');
console.log('UID:', user.uid);
console.log('Email:', user.email);

const allFiles = await db.collection('files').where('userId', '==', user.uid).get();
const errored = allFiles.docs.filter(d => d.data().extractionError != null);
console.log('\nTotal files:', allFiles.size);
console.log('Errored files:', errored.length);

// Group error messages
const errorCounts = {};
for (const d of errored) {
  const err = (d.data().extractionError || '').slice(0, 120);
  const key = err.match(/gemini-[\w.\-]+/)?.[0] || err.match(/[A-Z][a-z]+Error/)?.[0] || err.slice(0, 60);
  errorCounts[key] = (errorCounts[key] || 0) + 1;
}
console.log('\nError categories:');
for (const [k, v] of Object.entries(errorCounts).sort((a,b) => b[1]-a[1])) {
  console.log(`  ${v.toString().padStart(4)}× ${k}`);
}

const sample = errored.slice(0, 3).map(d => ({
  id: d.id,
  fileName: d.data().fileName,
  extractionError: (d.data().extractionError || '').slice(0, 250),
  uploadedAt: d.data().uploadedAt?.toDate?.()?.toISOString?.() ?? d.data().uploadedAt,
}));
console.log('\nSample errored files:');
console.log(JSON.stringify(sample, null, 2));
