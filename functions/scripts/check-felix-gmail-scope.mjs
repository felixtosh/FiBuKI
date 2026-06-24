import admin from 'firebase-admin';
import { execSync } from 'node:child_process';
import { decrypt } from '../lib/utils/encryption.js';

admin.initializeApp({ projectId: 'taxstudio-f12fb' });
const db = admin.firestore();

const ENCRYPTION_KEY = execSync('gcloud secrets versions access latest --secret=GMAIL_TOKEN_ENCRYPTION_KEY --project=taxstudio-f12fb', { encoding: 'utf8' }).trim();
const CLIENT_ID = execSync('gcloud secrets versions access latest --secret=GOOGLE_CLIENT_ID --project=taxstudio-f12fb', { encoding: 'utf8' }).trim();
const CLIENT_SECRET = execSync('gcloud secrets versions access latest --secret=GOOGLE_CLIENT_SECRET --project=taxstudio-f12fb', { encoding: 'utf8' }).trim();

const FELIX_INTEGRATION_ID = 'I9sOgObF944yuFRBkI0l';

const tokenSnap = await db.collection('emailTokens').doc(FELIX_INTEGRATION_ID).get();
const t = tokenSnap.data();
let refreshToken = t.refreshToken;
if (t.refreshTokenIv) {
  refreshToken = decrypt(t.refreshToken, t.refreshTokenIv, ENCRYPTION_KEY);
}

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
const body = await resp.json();
console.log(`Refresh status: ${resp.status}`);
console.log(`Scope: ${body.scope ?? '(none)'}`);
console.log(`Has gmail.readonly: ${(body.scope || '').includes('gmail.readonly')}`);

if (body.access_token) {
  const gmailResp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1', {
    headers: { Authorization: `Bearer ${body.access_token}` },
  });
  console.log(`Gmail messages.list status: ${gmailResp.status}`);
}
