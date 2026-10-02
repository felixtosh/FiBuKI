import { describe, it, expect } from "vitest";
import { authorizeReturnPath, decideAuthorizeStep, signInUrl, type AuthorizeFacts } from "@/lib/oauth/authorize-step";

const ready: AuthorizeFacts = {
  request: "valid",
  authLoading: false,
  signedIn: true,
  mfaPending: false,
  email: "max@example.at",
  hint: null,
  accountConfirmed: false,
  identityLoading: false,
  hasIdentity: true,
};
const step = (over: Partial<AuthorizeFacts>) => decideAuthorizeStep({ ...ready, ...over }).step;

describe("signed out", () => {
  it("is sent to sign in, with or without a hint", () => {
    expect(step({ signedIn: false, email: null })).toBe("sign-in");
    expect(step({ signedIn: false, email: null, hint: "max@example.at" })).toBe("sign-in");
  });

  it("waits for auth to settle first, so a signed-in user never flashes the sign-in screen", () => {
    expect(step({ authLoading: true, signedIn: false, email: null })).toBe("loading");
    expect(step({ authLoading: true })).toBe("loading");
  });

  it("a second factor still pending counts as not signed in yet", () => {
    expect(step({ mfaPending: true })).toBe("sign-in");
  });
});

describe("signed in", () => {
  it("goes straight to consent when there is no hint", () => {
    expect(step({})).toBe("consent");
  });

  it("goes straight to consent when the hint is the account they are signed in as (any case)", () => {
    expect(step({ hint: "max@example.at" })).toBe("consent");
    expect(step({ hint: "  MAX@Example.AT " })).toBe("consent");
  });

  it("asks which account when the app suggested another one", () => {
    expect(decideAuthorizeStep({ ...ready, hint: "anna@example.at" })).toEqual({
      step: "account-choice",
      current: "max@example.at",
      suggested: "anna@example.at",
    });
  });

  it("stops asking once the user chose to continue as the signed-in account", () => {
    expect(step({ hint: "anna@example.at", accountConfirmed: true })).toBe("consent");
  });

  it("needs an identity before consent, and waits for it to load", () => {
    expect(step({ hasIdentity: false })).toBe("identity");
    expect(step({ hasIdentity: false, identityLoading: true })).toBe("loading");
  });

  it("settles the account before asking for an identity", () => {
    expect(step({ hint: "anna@example.at", hasIdentity: false })).toBe("account-choice");
  });
});

describe("invalid request", () => {
  it("is shown whether or not anyone is signed in, and never leads to consent", () => {
    expect(step({ request: "invalid" })).toBe("invalid");
    expect(step({ request: "invalid", signedIn: false, email: null })).toBe("invalid");
  });

  it("waits for the check", () => {
    expect(step({ request: "loading" })).toBe("loading");
  });
});

describe("returning from sign-in", () => {
  const search = "?response_type=code&client_id=oc_1&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fcb&state=a%2Fb&code_challenge=abc&code_challenge_method=S256&login_hint=max%40example.at";

  it("the return path is this same authorize request", () => {
    expect(authorizeReturnPath(search)).toBe(`/oauth/authorize${search}`);
    expect(authorizeReturnPath(search.slice(1))).toBe(`/oauth/authorize${search}`);
    expect(authorizeReturnPath("")).toBe("/oauth/authorize");
  });

  it("sign-in carries the return path whole, plus the suggested email", () => {
    const url = new URL(signInUrl(authorizeReturnPath(search), "max@example.at"), "https://fibuki.com");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("email")).toBe("max@example.at");
    expect(url.searchParams.get("redirect")).toBe(`/oauth/authorize${search}`);
  });

  it("sign-up has no email field to fill, so it only carries the return path; no hint, no email parameter", () => {
    const register = new URL(signInUrl("/oauth/authorize?x=1", "max@example.at", "register"), "https://fibuki.com");
    expect(register.pathname).toBe("/register");
    expect(register.searchParams.has("email")).toBe(false);
    expect(new URL(signInUrl("/oauth/authorize?x=1", null), "https://fibuki.com").searchParams.has("email")).toBe(false);
  });
});
