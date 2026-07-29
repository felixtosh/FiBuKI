/**
 * Central download-URL construction.
 *
 * The backend hands out two shapes of Storage URL, each previously copy-pasted
 * across many files:
 *
 *   1. A Firebase Storage **token** URL (`/v0/b/<bucket>/o/<encodedPath>?
 *      alt=media&token=<t>`), emulator-aware. This was duplicated verbatim in
 *      ~6 queue/handler files plus the frontend `getFirebaseStorageDownloadUrl`
 *      in lib/firebase/admin.ts.
 *   2. A plain **GCS object** URL (`storage.googleapis.com/<bucket>/<path>`),
 *      optionally cache-busted, used by invoicing and inbound-email.
 *
 * Folding them here removes the duplication and — more importantly — gives the
 * whole codebase a single place where a URL is built, so a self-host build can
 * swap this one module (module-alias) to point downloads at its own host
 * instead of googleapis.com. Behavior for the Firebase build is unchanged.
 */

/**
 * Firebase Storage download URL with an access token. Mirrors the exact shape
 * the client SDK's getDownloadURL() produces, and honors the Storage emulator
 * when FIREBASE_STORAGE_EMULATOR_HOST is set.
 */
export function buildDownloadUrl(bucketName: string, storagePath: string, downloadToken: string): string {
  const encodedPath = encodeURIComponent(storagePath);
  const emulatorHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  const base = emulatorHost
    ? `http://${emulatorHost}`
    : "https://firebasestorage.googleapis.com";
  return `${base}/v0/b/${bucketName}/o/${encodedPath}?alt=media&token=${downloadToken}`;
}

/**
 * Plain Google Cloud Storage object URL. `cacheBust` appends `?v=<epoch-ms>`
 * (used when a stored PDF is regenerated at the same path and clients must not
 * serve a stale cached copy).
 */
export function buildStorageObjectUrl(
  bucketName: string,
  storagePath: string,
  opts?: { cacheBust?: boolean },
): string {
  const url = `https://storage.googleapis.com/${bucketName}/${storagePath}`;
  return opts?.cacheBust ? `${url}?v=${Date.now()}` : url;
}
