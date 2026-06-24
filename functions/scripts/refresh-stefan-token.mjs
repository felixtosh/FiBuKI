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

const CLIENT_ID = execSync(
  'gcloud secrets versions access latest --secret=GOOGLE_CLIENT_ID --project=taxstudio-f12fb',
  { encoding: 'utf8' },
).trim();

const CLIENT_SECRET = execSync(
  'gcloud secrets versions access latest --secret=GOOGLE_CLIENT_SECRET --project=taxstudio-f12fb',
  { encoding: 'utf8' },
).trim();

const user = await auth.getUserByEmail('stefan@houseofbandits.at');
const integrations = await db.collection('emailIntegrations').where('userId','==',user.uid).get();

for (const intDoc of integrations.docs) {
  const integration = intDoc.data();
  console.log(`\n=== ${integration.email} (${intDoc.id}) ===`);

  const tokenSnap = await db.collection('emailTokens').doc(intDoc.id).get();
  const t = tokenSnap.data();

  // Decrypt refresh token
  let refreshToken = t.refreshToken;
  if (t.refreshTokenIv) {
    try {
      refreshToken = decrypt(t.refreshToken, t.refreshTokenIv, ENCRYPTION_KEY);
      console.log(`  decrypted refresh token: len=${refreshToken.length}, starts with: ${refreshToken.slice(0, 6)}...`);
    } catch (err) {
      console.log(`  failed to decrypt: ${err.message}`);
      continue;
    }
  } else {
    console.log(`  refresh token not encrypted (no IV)`);
  }

  // Manual refresh
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const body = await resp.text();
  console.log(`  refresh status: ${resp.status}`);

  if (!resp.ok) {
    console.log(`  refresh failed: ${body.slice(0, 400)}`);
    continue;
  }

  const refreshed = JSON.parse(body);
  console.log(`  new access token len: ${refreshed.access_token?.length}`);
  console.log(`  new scope: ${refreshed.scope ?? '(none!)'}`);
  console.log(`  expires_in: ${refreshed.expires_in}`);

  // Introspect
  const introspect = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${refreshed.access_token}`);
  const info = await introspect.json();
  console.log(`  tokeninfo scope: ${info.scope ?? '-'}`);
  console.log(`  tokeninfo email: ${info.email ?? '-'}`);

  // Try Gmail call
  const gmailResp = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1',
    { headers: { Authorization: `Bearer ${refreshed.access_token}` } }
  );
  console.log(`  Gmail messages.list status (with fresh token): ${gmailResp.status}`);
  if (!gmailResp.ok) {
    const errBody = await gmailResp.text();
    console.log(`  Gmail error: ${errBody.slice(0, 400)}`);
  }
}
