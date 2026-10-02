"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { useAuth } from "@/components/auth";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { FibukiMascot } from "@/components/ui/fibuki-mascot";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callFunction } from "@/lib/firebase/callable";
import { hintedEmail } from "@/lib/auth/safe-redirect";
import { authorizeReturnPath, decideAuthorizeStep, signInUrl, type RequestState } from "@/lib/oauth/authorize-step";
import { useUserData } from "@/hooks/use-user-data";

/** Format examples, not copy: the same in every language. */
const VAT_EXAMPLE = "ATU12345678";
const IBAN_EXAMPLE = "AT61 1904 3002 3457 3201";

interface ClientInfo {
  valid: boolean;
  clientName?: string;
  redirectHost?: string;
  verified?: boolean;
  description?: string;
  /** Where to send the error, when the app can be told about it. */
  redirectUrl?: string;
}

interface AuthorizeResponse {
  redirectUrl: string;
}

/**
 * The page a connecting app (ChatGPT, Claude, Codex) sends the user to. It works the same
 * whether the user arrives signed out, signed in, or signed in as a different account than the
 * app suggested: sign in or up (and come back here), settle which account, make sure FiBuKI
 * knows who the user is, then ask for consent and return to the app with a one-time code.
 */
export function AuthorizeFlow() {
  const t = useTranslations("oauth.authorize");
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();

  const { user, loading: authLoading, signOut, mfaRequired, customMfaRequired } = useAuth();
  const { loading: userDataLoading, isConfigured: hasIdentity } = useUserData();

  const [info, setInfo] = useState<ClientInfo | null>(null);
  const [accountConfirmed, setAccountConfirmed] = useState(false);

  const hint = useMemo(() => hintedEmail(searchParams.get("login_hint")) || null, [searchParams]);
  const returnPath = authorizeReturnPath(queryString);

  // Is this request valid, and who is asking? Needs no sign-in, so it runs straight away.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/oauth/client?${queryString}`)
      .then(async (res) => (await res.json()) as ClientInfo)
      .then((body) => !cancelled && setInfo(body))
      .catch(() => !cancelled && setInfo({ valid: false }));
    return () => {
      cancelled = true;
    };
  }, [queryString]);

  const requestState: RequestState = !info ? "loading" : info.valid ? "valid" : "invalid";
  const decision = decideAuthorizeStep({
    request: requestState,
    authLoading,
    signedIn: !!user,
    mfaPending: !!(mfaRequired || customMfaRequired),
    email: user?.email ?? null,
    hint,
    accountConfirmed,
    identityLoading: userDataLoading,
    hasIdentity,
  });

  const app = info?.clientName ?? t("thisApp");
  const goToSignIn = (page: "login" | "register", email: string | null) =>
    router.push(signInUrl(returnPath, email, page));

  const switchAccount = async (email: string | null) => {
    await signOut();
    router.replace(signInUrl(returnPath, email));
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="space-y-1 text-center">
        <div className="flex justify-center mb-2">
          <FibukiMascot size={40} forceFacingRight />
        </div>
        {decision.step === "loading" && <CardTitle className="text-xl">{t("loading")}</CardTitle>}

        {decision.step === "invalid" && (
          <>
            <CardTitle className="text-xl">{t("invalid.title")}</CardTitle>
            <CardDescription>{info?.description ?? t("invalid.body")}</CardDescription>
          </>
        )}

        {decision.step === "sign-in" && (
          <>
            <CardTitle className="text-xl">{t("signIn.title", { app })}</CardTitle>
            <CardDescription>{t("signIn.body")}</CardDescription>
          </>
        )}

        {decision.step === "account-choice" && (
          <>
            <CardTitle className="text-xl">{t("accountChoice.title")}</CardTitle>
            <CardDescription>
              {t("accountChoice.body", { current: decision.current, suggested: decision.suggested, app })}
            </CardDescription>
          </>
        )}

        {decision.step === "identity" && (
          <>
            <CardTitle className="text-xl">{t("identity.title")}</CardTitle>
            <CardDescription>{t("identity.body")}</CardDescription>
          </>
        )}

        {decision.step === "consent" && <CardTitle className="text-xl">{t("consent.title", { app })}</CardTitle>}
      </CardHeader>

      {decision.step === "loading" && (
        <CardContent className="flex justify-center py-6">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      )}

      {decision.step === "invalid" && info?.redirectUrl && (
        <CardFooter>
          <Button className="w-full" variant="outline" asChild>
            <a href={info.redirectUrl}>{t("invalid.back", { app })}</a>
          </Button>
        </CardFooter>
      )}

      {decision.step === "sign-in" && (
        <>
          <CardContent className="space-y-3">
            {hint && <p className="text-sm text-center text-muted-foreground">{t("signIn.hint", { app, email: hint })}</p>}
            <AppIdentity info={info} />
          </CardContent>
          <CardFooter className="flex flex-col gap-2">
            <Button className="w-full" onClick={() => goToSignIn("login", hint)}>
              {mfaRequired || customMfaRequired ? t("signIn.finish") : t("signIn.signIn")}
            </Button>
            <Button className="w-full" variant="outline" onClick={() => goToSignIn("register", hint)}>
              {t("signIn.create")}
            </Button>
          </CardFooter>
        </>
      )}

      {decision.step === "account-choice" && (
        <CardFooter className="flex flex-col gap-2">
          <Button className="w-full" onClick={() => setAccountConfirmed(true)}>
            {t("accountChoice.continueAs", { current: decision.current })}
          </Button>
          <Button className="w-full" variant="outline" onClick={() => switchAccount(decision.suggested)}>
            {t("accountChoice.useOther", { suggested: decision.suggested })}
          </Button>
        </CardFooter>
      )}

      {decision.step === "identity" && <IdentityStep />}

      {decision.step === "consent" && (
        <Consent
          info={info}
          email={user?.email ?? ""}
          params={searchParams}
          onSwitchAccount={() => switchAccount(hint)}
        />
      )}
    </Card>
  );
}

/** Who is asking, as evidence rather than as a claim: the name is the app's own, the host is where it returns to. */
function AppIdentity({ info }: { info: ClientInfo | null }) {
  const t = useTranslations("oauth.authorize");
  if (!info?.valid) return null;
  if (info.verified) {
    return (
      <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
        <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
        {t("returnsTo", { host: info.redirectHost ?? "" })}
      </p>
    );
  }
  return (
    <Alert className="border-amber-200 bg-amber-50 text-amber-900">
      <AlertCircle className="h-4 w-4 text-amber-600" />
      <AlertDescription>{t("unverified", { host: info.redirectHost ?? "" })}</AlertDescription>
    </Alert>
  );
}

/**
 * Tells FiBuKI who the user is, which is what keeps their own issued invoices apart from the
 * invoices they receive. Only what is needed to start; the rest is in Settings.
 */
function IdentityStep() {
  const t = useTranslations("oauth.authorize.identity");
  const { save } = useUserData();
  const [name, setName] = useState("");
  const [vatId, setVatId] = useState("");
  const [iban, setIban] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(false);
    try {
      await save({
        personalEntity: {
          type: "person",
          name: name.trim(),
          aliases: [],
          ibans: iban.trim() ? [iban] : [],
          ...(vatId.trim() ? { vatId } : {}),
        },
      });
    } catch (err) {
      console.error("Failed to save identity:", err);
      setError(true);
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{t("error")}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          <Label htmlFor="identity-name">{t("name")}</Label>
          <Input id="identity-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required autoFocus />
        </div>
        <div className="space-y-2">
          <Label htmlFor="identity-vat">{t("vatId")}</Label>
          <Input id="identity-vat" value={vatId} onChange={(e) => setVatId(e.target.value)} placeholder={VAT_EXAMPLE} autoComplete="off" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="identity-iban">{t("iban")}</Label>
          <Input id="identity-iban" value={iban} onChange={(e) => setIban(e.target.value)} placeholder={IBAN_EXAMPLE} autoComplete="off" />
        </div>
      </CardContent>
      <CardFooter>
        <Button type="submit" className="w-full" disabled={saving || !name.trim()}>
          {saving ? t("saving") : t("save")}
        </Button>
      </CardFooter>
    </form>
  );
}

function Consent({
  info,
  email,
  params,
  onSwitchAccount,
}: {
  info: ClientInfo | null;
  email: string;
  params: URLSearchParams;
  onSwitchAccount: () => void;
}) {
  const t = useTranslations("oauth.authorize.consent");
  const [working, setWorking] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState(false);
  const app = info?.clientName ?? "";

  const decide = async (decision: "allow" | "deny") => {
    setWorking(decision);
    setError(false);
    try {
      const { redirectUrl } = await callFunction<unknown, AuthorizeResponse>("createOAuthAuthorization", {
        clientId: params.get("client_id"),
        redirectUri: params.get("redirect_uri"),
        responseType: params.get("response_type"),
        scope: params.get("scope") ?? undefined,
        state: params.get("state") ?? undefined,
        codeChallenge: params.get("code_challenge"),
        codeChallengeMethod: params.get("code_challenge_method"),
        resource: params.get("resource") ?? undefined,
        decision,
      });
      window.location.assign(redirectUrl);
    } catch (err) {
      console.error("OAuth consent failed:", err);
      setError(true);
      setWorking(null);
    }
  };

  return (
    <>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{t("error")}</AlertDescription>
          </Alert>
        )}
        <AppIdentity info={info} />
        <div className="space-y-2">
          <p className="text-sm font-medium">{t("canDo", { app })}</p>
          <ul className="space-y-1.5 text-sm text-muted-foreground list-disc pl-5">
            <li>{t("seeData")}</li>
            <li>{t("organise")}</li>
            <li>{t("upload")}</li>
          </ul>
          <p className="text-sm text-muted-foreground">{t("cannot")}</p>
          <p className="text-xs text-muted-foreground">
            {t("disconnect")}{" "}
            <Link href="/settings/integrations" className="underline" target="_blank">
              {t("settings")}
            </Link>
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("signedInAs", { email })}{" "}
          <button type="button" onClick={onSwitchAccount} className="underline">
            {t("switchAccount")}
          </button>
        </p>
      </CardContent>
      <CardFooter className="flex flex-col gap-2">
        <Button className="w-full" onClick={() => decide("allow")} disabled={working !== null}>
          {working === "allow" ? t("working") : t("allow")}
        </Button>
        <Button className="w-full" variant="outline" onClick={() => decide("deny")} disabled={working !== null}>
          {t("cancel")}
        </Button>
      </CardFooter>
    </>
  );
}
