/**
 * Server-side helper for calling Cloud Functions from API routes.
 *
 * Use this in API routes (server-side) instead of the client-side callable.ts.
 *
 * Every call takes the caller's Authorization header as an argument and
 * forwards it to the backend at NEXT_PUBLIC_FUNCTIONS_URL (fibuki-api).
 */

import { CloudFunctionName } from "@/types/function-call";
import { functionsUrl, FUNCTIONS_URL_UNSET_ERROR } from "@/lib/api/functions-origin";

interface CloudFunctionResponse<T> {
  result?: T;
  error?: {
    message: string;
    code?: string;
    details?: unknown;
  };
}

/**
 * Get the function URL: the configured backend, or nothing. There is no Cloud
 * Functions or emulator default any more: a deployment that has not said where
 * its backend lives must fail here rather than post the caller's bearer token
 * somewhere else. See lib/api/functions-origin.ts.
 */
function getFunctionUrl(name: string): string {
  const configured = functionsUrl(name);
  if (configured) return configured;
  throw new Error(FUNCTIONS_URL_UNSET_ERROR);
}

/** The bare token from an Authorization header value (with or without "Bearer "). */
function tokenOf(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  return authHeader.startsWith("Bearer ") ? authHeader.substring(7) : authHeader;
}

/**
 * Call a Cloud Function from server-side code (API routes), as the caller
 * whose Authorization header is passed.
 *
 * The header is a parameter, not module state, on purpose. It used to be
 * set once per request into a module-level variable and read here later;
 * one server process handles many users' requests concurrently, so a
 * request that awaited in between could send its call with another user's
 * token, running its arguments as that user.
 *
 * @example
 * ```typescript
 * const result = await callCloudFunction<CreateRequest, CreateResponse>(
 *   "createBankingConnection",
 *   { providerId: "finapi", ... },
 *   request.headers.get("Authorization")
 * );
 * ```
 */
export async function callCloudFunction<TRequest, TResponse>(
  name: CloudFunctionName,
  data: TRequest,
  authHeader: string | null
): Promise<TResponse> {
  const authToken = tokenOf(authHeader);
  const functionUrl = getFunctionUrl(name);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  // No token, no header (public endpoints).
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

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
  data: TRequest,
  authHeader: string | null
): void {
  callCloudFunction(name, data, authHeader).catch((err) => {
    console.error(`[callCloudFunctionBackground] ${name} failed:`, err);
  });
}
