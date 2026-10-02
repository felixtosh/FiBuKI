/**
 * The authorize page, as the three kinds of visitor meet it: signed out, signed in as the
 * suggested account, and signed in as another one. Real component and real (English) messages;
 * only the router, auth, user data, the callable and the client-info request are stubbed.
 */

import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "@/messages/en.json";

const nav = vi.hoisted(() => ({ query: "", push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.query),
}));

const auth = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  signOut: vi.fn(async () => undefined),
}));
vi.mock("@/components/auth", () => ({
  useAuth: () => ({ ...auth.state, signOut: auth.signOut }),
}));

const userData = vi.hoisted(() => ({ state: {} as Record<string, unknown>, save: vi.fn(async () => undefined) }));
vi.mock("@/hooks/use-user-data", () => ({
  useUserData: () => ({ ...userData.state, save: userData.save }),
}));

const callable = vi.hoisted(() => ({ callFunction: vi.fn() }));
vi.mock("@/lib/firebase/callable", () => callable);

const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const REQUEST =
  `response_type=code&client_id=oc_1&redirect_uri=${encodeURIComponent(REDIRECT)}&state=st-1` +
  "&code_challenge=" + "c".repeat(43) + "&code_challenge_method=S256&scope=fibuki&resource=" +
  encodeURIComponent("https://fibuki.com/api/mcp/sse");

const verified = { valid: true, clientName: "ChatGPT", redirectHost: "chatgpt.com", verified: true };
const assign = vi.fn();

function mountWith(query: string, info: Record<string, unknown> = verified) {
  nav.query = query;
  vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => info })));
  return import("@/components/oauth/authorize-flow").then(({ AuthorizeFlow }) =>
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AuthorizeFlow />
      </NextIntlClientProvider>
    )
  );
}

const signedOut = { user: null, loading: false, mfaRequired: false, customMfaRequired: false };
const signedInAs = (email: string) => ({ user: { email }, loading: false, mfaRequired: false, customMfaRequired: false });

beforeEach(() => {
  vi.clearAllMocks();
  auth.state = signedOut;
  userData.state = { loading: false, isConfigured: true };
  // jsdom cannot navigate; the page leaves through location.assign, which is what is asserted.
  Object.defineProperty(window, "location", {
    value: { href: "https://fibuki.com/oauth/authorize", origin: "https://fibuki.com", protocol: "https:", host: "fibuki.com", hostname: "fibuki.com", pathname: "/oauth/authorize", search: "", hash: "", assign },
    writable: true,
  });
});

describe("signed out", () => {
  it("offers sign in and sign up, and both come back to this request; the suggested email is carried to sign in", async () => {
    await mountWith(`${REQUEST}&login_hint=max%40example.at`);
    expect(await screen.findByText("Connect ChatGPT to FiBuKI")).toBeTruthy();
    expect(screen.getByText("ChatGPT suggested max@example.at.")).toBeTruthy();
    expect(screen.getByText("Returns to chatgpt.com")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    const login = new URL(nav.push.mock.calls[0][0], "https://fibuki.com");
    expect(login.pathname).toBe("/login");
    expect(login.searchParams.get("email")).toBe("max@example.at");
    expect(login.searchParams.get("redirect")).toBe(`/oauth/authorize?${new URLSearchParams(REQUEST + "&login_hint=max%40example.at").toString()}`);

    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    const register = new URL(nav.push.mock.calls[1][0], "https://fibuki.com");
    expect(register.pathname).toBe("/register");
    expect(register.searchParams.has("email")).toBe(false);
    expect(register.searchParams.get("redirect")).toContain("/oauth/authorize?");
  });

  it("works without a hint", async () => {
    await mountWith(REQUEST);
    await screen.findByText("Connect ChatGPT to FiBuKI");
    expect(screen.queryByText(/suggested/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(new URL(nav.push.mock.calls[0][0], "https://fibuki.com").searchParams.has("email")).toBe(false);
  });

  it("an app FiBuKI cannot verify is shown with its host and a warning", async () => {
    await mountWith(REQUEST, { valid: true, clientName: "ChatGPT", redirectHost: "evil.example", verified: false });
    expect(await screen.findByText(/could not verify this app/)).toBeTruthy();
    expect(screen.getByText(/evil\.example/)).toBeTruthy();
  });

  it("does not flash the sign-in screen while auth is still resolving", async () => {
    auth.state = { ...signedOut, loading: true };
    await mountWith(REQUEST);
    await screen.findByText("One moment…");
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("finishing a second factor is a sign-in step, not consent", async () => {
    auth.state = { user: { email: "max@example.at" }, loading: false, mfaRequired: true, customMfaRequired: false };
    await mountWith(REQUEST);
    expect(await screen.findByRole("button", { name: "Finish signing in" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });
});

describe("signed in", () => {
  it("goes straight to consent and sends the user back to the app with the code", async () => {
    auth.state = signedInAs("max@example.at");
    callable.callFunction.mockResolvedValue({ redirectUrl: `${REDIRECT}?code=abc&state=st-1&iss=https%3A%2F%2Ffibuki.com` });
    await mountWith(`${REQUEST}&login_hint=MAX%40example.at`);

    expect(await screen.findByText("Connect ChatGPT?")).toBeTruthy();
    expect(screen.getByText(/It cannot delete individual transactions/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith(`${REDIRECT}?code=abc&state=st-1&iss=https%3A%2F%2Ffibuki.com`));
    expect(callable.callFunction).toHaveBeenCalledWith("createOAuthAuthorization", {
      clientId: "oc_1",
      redirectUri: REDIRECT,
      responseType: "code",
      scope: "fibuki",
      state: "st-1",
      codeChallenge: "c".repeat(43),
      codeChallengeMethod: "S256",
      resource: "https://fibuki.com/api/mcp/sse",
      decision: "allow",
    });
  });

  it("cancel tells the app the user said no", async () => {
    auth.state = signedInAs("max@example.at");
    callable.callFunction.mockResolvedValue({ redirectUrl: `${REDIRECT}?error=access_denied&state=st-1` });
    await mountWith(REQUEST);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`${REDIRECT}?error=access_denied&state=st-1`));
    expect(callable.callFunction.mock.calls[0][1]).toMatchObject({ decision: "deny" });
  });

  it("a failed consent shows an error and lets the user try again", async () => {
    auth.state = signedInAs("max@example.at");
    callable.callFunction.mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mountWith(REQUEST);
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    expect(await screen.findByText("Something went wrong. Please try again.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement).disabled).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it("asks which account when the app suggested a different one", async () => {
    auth.state = signedInAs("max@example.at");
    await mountWith(`${REQUEST}&login_hint=anna%40example.at`);
    expect(await screen.findByText("Which account?")).toBeTruthy();
    expect(screen.getByText("You're signed in as max@example.at, but ChatGPT suggested anna@example.at.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Continue as max@example.at" }));
    expect(await screen.findByText("Connect ChatGPT?")).toBeTruthy();
  });

  it("choosing the suggested account signs out and returns to sign-in with that email, back to this request", async () => {
    auth.state = signedInAs("max@example.at");
    await mountWith(`${REQUEST}&login_hint=anna%40example.at`);
    fireEvent.click(await screen.findByRole("button", { name: "Use anna@example.at" }));

    await waitFor(() => expect(nav.replace).toHaveBeenCalled());
    expect(auth.signOut).toHaveBeenCalled();
    const url = new URL(nav.replace.mock.calls[0][0], "https://fibuki.com");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("email")).toBe("anna@example.at");
    expect(url.searchParams.get("redirect")).toContain("/oauth/authorize?");
  });

  it("asks who the user is before consent, when FiBuKI does not know yet", async () => {
    auth.state = signedInAs("max@example.at");
    userData.state = { loading: false, isConfigured: false };
    await mountWith(REQUEST);
    expect(await screen.findByText("First, who are you?")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Name as on your invoices"), { target: { value: " Max Muster " } });
    fireEvent.change(screen.getByLabelText("UID (optional)"), { target: { value: "ATU12345678" } });
    fireEvent.change(screen.getByLabelText("Your IBAN (optional)"), { target: { value: "AT61 1904 3002 3457 3201" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(userData.save).toHaveBeenCalled());
    expect(userData.save).toHaveBeenCalledWith({
      personalEntity: { type: "person", name: "Max Muster", aliases: [], ibans: ["AT61 1904 3002 3457 3201"], vatId: "ATU12345678" },
    });
  });

  it("the identity form needs a name and sends no empty UID or IBAN", async () => {
    auth.state = signedInAs("max@example.at");
    userData.state = { loading: false, isConfigured: false };
    await mountWith(REQUEST);
    const button = (await screen.findByRole("button", { name: "Continue" })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Name as on your invoices"), { target: { value: "Max Muster" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(userData.save).toHaveBeenCalled());
    expect(userData.save).toHaveBeenCalledWith({ personalEntity: { type: "person", name: "Max Muster", aliases: [], ibans: [] } });
  });
});

describe("a request that cannot be used", () => {
  it("is explained, to a signed-out visitor too, and never offers consent", async () => {
    await mountWith("client_id=oc_nope", { valid: false, description: "Unknown client" });
    expect(await screen.findByText("This connection request can't be used")).toBeTruthy();
    expect(screen.getByText("Unknown client")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("link")).toBeNull(); // nowhere safe to send them
  });

  it("when the app can be told, there is a way back to it", async () => {
    auth.state = signedInAs("max@example.at");
    await mountWith(REQUEST, { valid: false, description: "Supported scopes: fibuki", redirectUrl: `${REDIRECT}?error=invalid_scope&state=st-1` });
    const back = (await screen.findByRole("link", { name: /Back to/ })) as HTMLAnchorElement;
    expect(back.getAttribute("href")).toBe(`${REDIRECT}?error=invalid_scope&state=st-1`);
  });

  it("an unreachable check is treated as unusable, not as permission", async () => {
    nav.query = REQUEST;
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    auth.state = signedInAs("max@example.at");
    const { AuthorizeFlow } = await import("@/components/oauth/authorize-flow");
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AuthorizeFlow />
      </NextIntlClientProvider>
    );
    expect(await screen.findByText("This connection request can't be used")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });
});
