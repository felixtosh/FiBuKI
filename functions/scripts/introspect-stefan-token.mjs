import admin from 'firebase-admin';
import { execSync } from 'node:child_process';
import { decrypt } from '../lib/utils/encryption.js';

admin.initializeApp({ projectId: 'taxstudio-f12fb' });
const auth = admin.auth();
const db = admin.firestore();

const ENCRYPTION_KEY = execSync(
  'gcloud secrets versions access latest --secret=GMAIL_TOKEN_ENCRYPTION_KEY --project=taxstudio-f12fb',
  { encoding: 'utf8' },
).trim();

const user = await auth.getUserByEmail('stefan@houseofbandits.at');
const integrations = await db.collection('emailIntegrations').where('userId','==',user.uid).get();

for (const intDoc of integrations.docs) {
  const integration = intDoc.data();
  console.log(`\n=== ${integration.email} (${intDoc.id}) ===`);

  const tokenSnap = await db.collection('emailTokens').doc(intDoc.id).get();
  if (!tokenSnap.exists) { console.log('  no token doc'); continue; }
  const t = tokenSnap.data();

  // access_token is stored unencrypted (string) per searchGmailCallable code
  const accessToken = t.accessToken;
  console.log(`  accessToken length: ${accessToken?.length}`);
  console.log(`  expiresAt: ${t.expiresAt?.toDate?.()?.toISOString?.()}`);
  console.log(`  expired: ${t.expiresAt?.toDate?.() < new Date()}`);

  // Try to introspect the access token via Google
  try {
    const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    const info = await resp.json();
    console.log(`  tokeninfo status: ${resp.status}`);
    console.log(`  scopes: ${info.scope ?? '(none)'}`);
    console.log(`  audience: ${info.aud ?? '-'}`);
    console.log(`  email: ${info.email ?? '-'}`);
    console.log(`  expires_in: ${info.expires_in ?? '-'}`);
    if (info.error) console.log(`  error: ${info.error_description ?? info.error}`);
  } catch (err) {
    console.log(`  tokeninfo error: ${err.message}`);
  }

  // Also try a Gmail call
  try {
    const resp = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const body = await resp.text();
    console.log(`  Gmail messages.list status: ${resp.status}`);
    if (!resp.ok) console.log(`  Gmail response: ${body.slice(0, 250)}`);
  } catch (err) {
    console.log(`  Gmail call error: ${err.message}`);
  }
}
