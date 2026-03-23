/**
 * Server-side helper for calling Cloud Functions from API routes.
 *
 * Use this in API routes (server-side) instead of the client-side callable.ts.
 *
 * In production: Uses Google Auth for service-to-service authentication.
 * In development/emulator: Forwards the user's auth token from the request.
 */

import { CloudFunctionName } from "@/types/function-call";

interface CloudFunctionResponse<T> {
  result?: T;
  error?: {
    message: string;
    code?: string;
    details?: unknown;
  };
}

/**
 * Get the project ID from environment variables
 */
function getProjectId(): string {
  return (
    process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "taxstudio-f12fb"
  );
}

/**
 * Check if we're using Firebase emulator
 */
function isEmulator(): boolean {
  return !!(
    process.env.FUNCTIONS_EMULATOR ||
    process.env.FIREBASE_EMULATOR_HOST ||
    process.env.FIRESTORE_EMULATOR_HOST ||
    (process.env.NODE_ENV === "development" && !process.env.USE_PRODUCTION_FUNCTIONS)
  );
}

/**
 * Get the function URL (emulator or production)
 */
function getFunctionUrl(name: string): string {
  const projectId = getProjectId();
  const region = "europe-west1";

  if (isEmulator()) {
    // Emulator URL format: http://127.0.0.1:5001/{projectId}/{region}/{functionName}
    const emulatorHost = process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";
    return `http://${emulatorHost}/${projectId}/${region}/${name}`;
  }

  // Production URL
  return `https://${region}-${projectId}.cloudfunctions.net/${name}`;
}

// Store for current request's auth token
let currentAuthToken: string | null = null;

/**
 * Set the auth token for the current request.
 * Call this at the beginning of your API route with the Authorization header value.
 *
 * @example
 * ```typescript
 * setAuthToken(request.headers.get("Authorization"));
 * ```
 */
export function setAuthToken(authHeader: string | null): void {
  if (authHeader?.startsWith("Bearer ")) {
    currentAuthToken = authHeader.substring(7);
  } else {
    currentAuthToken = authHeader;
  }
}

/**
 * Call a Cloud Function from server-side code (API routes).
 *
 * IMPORTANT: Call setAuthToken() first with the request's Authorization header.
 *
 * @example
 * ```typescript
 * // In your API route:
 * setAuthToken(request.headers.get("Authorization"));
 * const result = await callCloudFunction<CreateRequest, CreateResponse>(
 *   "createBankingConnection",
 *   { providerId: "finapi", ... }
 * );
 * ```
 */
export async function callCloudFunction<TRequest, TResponse>(
  name: CloudFunctionName,
  data: TRequest
): Promise<TResponse> {
  const functionUrl = getFunctionUrl(name);
  const useEmulator = isEmulator();

  let headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (useEmulator) {
    console.log(`[callCloudFunction] Emulator mode - calling ${name}`);
    // For emulator: forward the user's auth token
    if (currentAuthToken) {
      headers["Authorization"] = `Bearer ${currentAuthToken}`;
    } else {
      console.warn(`[callCloudFunction] No auth token set - call setAuthToken() first`);
    }
  } else if (currentAuthToken) {
    // Production with user auth: Forward the Firebase ID token
    headers["Authorization"] = `Bearer ${currentAuthToken}`;
  }
  // If no auth token is set, don't add any auth header (for public endpoints)

  const response = await fetch(functionUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ data }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMessage = `Cloud Function ${name} failed: ${response.status}`;
    try {
      const errorJson = JSON.parse(errorText) as CloudFunctionResponse<unknown>;
      if (errorJson.error?.message) {
        errorMessage = errorJson.error.message;
      }
    } catch {
      // Use default error message
    }
    throw new Error(errorMessage);
  }

  const result = (await response.json()) as CloudFunctionResponse<TResponse>;

  if (result.error) {
    throw new Error(result.error.message || "Cloud Function returned an error");
  }

  return result.result as TResponse;
}

/**
 * Call a Cloud Function in the background (fire and forget).
 * Useful for triggering async operations like sync.
 * Errors are logged but not thrown.
 */
export function callCloudFunctionBackground<TRequest>(
  name: CloudFunctionName,
  data: TRequest
): void {
  callCloudFunction(name, data).catch((err) => {
    console.error(`[callCloudFunctionBackground] ${name} failed:`, err);
  });
}
