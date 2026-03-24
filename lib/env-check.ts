/**
 * Dev-only environment validation.
 * Warns when NEXT_PUBLIC_FIREBASE_* env vars are missing and hardcoded
 * fallbacks are being used. Does NOT crash — the fallbacks still work.
 */

const FIREBASE_ENV_VARS = [
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
  "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
] as const;

let _checked = false;

export function validateEnv(): void {
  if (_checked) return;
  if (process.env.NODE_ENV !== "development") return;
  _checked = true;

  const missing = FIREBASE_ENV_VARS.filter((key) => !process.env[key]);

  if (missing.length === 0) return;

  console.warn(
    "\x1b[33m[env-check] Missing Firebase env vars — using hardcoded fallbacks:\x1b[0m"
  );
  for (const key of missing) {
    console.warn(`  \x1b[33m- ${key}\x1b[0m`);
  }
  console.warn(
    "\x1b[33mCopy .env.example to .env.local and fill in your values.\x1b[0m\n"
  );
}
