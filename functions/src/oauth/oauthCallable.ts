/**
 * The user's decision on an authorization request, made on the authorize page while
 * signed in. Allow returns the redirect carrying the one-time code; deny returns the
 * redirect carrying access_denied. Either way the page just navigates to the URL.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import { ensureOnboarding } from "../onboarding/onboardingState";
import { OAuthRequestError } from "./oauthCore";
import {
  buildClientRedirect,
  createAuthorizationCode,
  validateAuthorizeRequest,
} from "./oauthStore";

interface CreateOAuthAuthorizationRequest {
  clientId: string;
  redirectUri: string;
  responseType: string;
  scope?: string;
  state?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource?: string;
  decision: "allow" | "deny";
}

export const createOAuthAuthorizationCallable = createCallable<
  CreateOAuthAuthorizationRequest,
  { redirectUrl: string }
>({ name: "createOAuthAuthorization" }, async (ctx, request) => {
  if (request?.decision !== "allow" && request?.decision !== "deny") {
    throw new HttpsError("invalid-argument", "decision must be allow or deny");
  }

  let valid;
  try {
    valid = await validateAuthorizeRequest(ctx.db, request);
  } catch (error) {
    if (!(error instanceof OAuthRequestError)) throw error;
    if (!error.redirectable) throw new HttpsError("invalid-argument", error.message);
    return {
      redirectUrl: buildClientRedirect(request.redirectUri, { error: error.code, description: error.message }, request.state),
    };
  }

  if (request.decision === "deny") {
    return { redirectUrl: buildClientRedirect(valid.redirectUri, { error: "access_denied" }, valid.state) };
  }

  // A user who signs up through an app is recorded as coming from it, taken from the
  // client that is connecting, never from a header the browser sends. The call that
  // creates the onboarding record is the only one that sets it.
  try {
    await ensureOnboarding(ctx.db, ctx.userId, valid.app.origin);
  } catch (error) {
    console.error("[oauth] could not record the onboarding origin", error);
  }

  const code = await createAuthorizationCode(ctx.db, ctx.userId, valid);
  return { redirectUrl: buildClientRedirect(valid.redirectUri, { code }, valid.state) };
});
