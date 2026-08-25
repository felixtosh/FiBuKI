"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  Mail,
  ArrowLeft,
  Loader2,
  Check,
  AlertCircle,
  Info,
  Trash2,
  Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useEmailIntegrations } from "@/hooks/use-email-integrations";
import { useActiveSyncForIntegration } from "@/hooks/use-integration-details";
import { usePageTitle } from "@/hooks/use-page-title";
import { fetchWithAuth } from "@/lib/api/fetch-with-auth";
import { toDateSafe } from "@/lib/utils";
import { EmailIntegration } from "@/types/email-integration";
// Value import, not type-only: classify-error.ts has zero dependencies of its
// own (no imapflow, no firebase-admin), so this stays a few literals in the
// client bundle rather than pulling in functions/ runtime code. If that file
// ever grows a real dependency, these two constants should move to a
// dependency-free module of their own rather than keep importing from here.
import {
  FATAL_IMAP_ERROR_CODES,
  IMAP_ERROR_MESSAGES,
} from "@/functions/src/mail/imap/classify-error";

export default function ImapIntegrationPage() {
  const router = useRouter();
  usePageTitle("IMAP Mailbox");

  const { integrations, loading, connectImap, disconnect } = useEmailIntegrations();
  const imapIntegrations = integrations.filter((i) => i.provider === "imap");

  const [host, setHost] = useState("");
  const [port, setPort] = useState("993");
  const [secure, setSecure] = useState(true);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [mailbox, setMailbox] = useState("INBOX");
  const [allowSelfSigned, setAllowSelfSigned] = useState(false);
  const [keywordPrefilter, setKeywordPrefilter] = useState(true);

  const [connecting, setConnecting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  // Set by "Fix & reconnect" on a broken mailbox row: the connect form doubles
  // as the reconnect form (an in-place reconnect is not available — the
  // duplicate check refuses a second active row for the same mailbox). The
  // broken integration is disconnected only at submit time, not on click —
  // clicking "Fix & reconnect" must not delete the mailbox before the user
  // has entered a working password and actually confirmed the fix.
  const [reconnectTarget, setReconnectTarget] = useState<{
    id: string;
    email: string;
  } | null>(null);
  const connectFormRef = useRef<HTMLDivElement>(null);

  // Pull-New-Files state, per mailbox. This page has no toast surface, so the
  // outcome is reported in an inline alert under the row, like the connect
  // form above does.
  const [pulling, setPulling] = useState<string | null>(null);
  const [pullResult, setPullResult] = useState<
    Record<string, { ok: boolean; text: string }>
  >({});

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSuccess(false);
    setConnecting(true);
    try {
      // Reconnecting a broken mailbox: the duplicate check refuses a second
      // active row for the same mailbox, so the old one is disconnected here,
      // right before the new credentials are verified — not back when the
      // user clicked "Fix & reconnect". If disconnect succeeds but the new
      // login then fails, the mailbox is gone; that trade-off only exists once
      // the user has actually submitted a password, never on a stray click.
      if (reconnectTarget) {
        await disconnect(reconnectTarget.id);
      }
      await connectImap({
        host: host.trim(),
        port: Number(port) || 993,
        secure,
        user: user.trim(),
        password,
        mailbox: mailbox.trim() || "INBOX",
        allowSelfSigned,
        keywordPrefilter,
      });
      setSuccess(true);
      setReconnectTarget(null);
      setPassword("");
      setHost("");
      setUser("");
      setMailbox("INBOX");
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to connect mailbox");
    } finally {
      setConnecting(false);
    }
  };

  /**
   * Queue an immediate sync for one mailbox.
   *
   * `force` makes the endpoint cover a trailing window on top of any detected
   * gap; without it a mailbox whose synced range already runs to now — the
   * normal state after a nightly sync — answers "already up to date" and the
   * press does nothing.
   *
   * The row disables the button itself for an active sync and for a fatal
   * classified error (auth_failed, mailbox_not_found — see
   * FATAL_IMAP_ERROR_CODES); anything else the endpoint still guards: a
   * running sync it doesn't know about yet answers SYNC_IN_PROGRESS and a
   * second press inside five minutes answers RATE_LIMITED, both reported in
   * the alert below the row.
   */
  const handlePullFiles = async (id: string) => {
    setPulling(id);
    setPullResult((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

    try {
      const response = await fetchWithAuth("/api/gmail/sync", {
        method: "POST",
        body: JSON.stringify({ integrationId: id, force: true }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        // A sync that is already running is not a failure — it is the outcome
        // the user wanted, just already under way.
        if (data.code === "SYNC_IN_PROGRESS" || data.code === "INITIAL_SYNC_PENDING") {
          setPullResult((prev) => ({
            ...prev,
            [id]: { ok: true, text: "A sync is already running for this mailbox." },
          }));
          return;
        }
        setPullResult((prev) => ({
          ...prev,
          [id]: { ok: false, text: data.error || "Failed to start sync" },
        }));
        return;
      }

      setPullResult((prev) => ({
        ...prev,
        [id]: { ok: true, text: "Fetching new mail now. New invoices appear in Files." },
      }));
    } catch {
      setPullResult((prev) => ({
        ...prev,
        [id]: { ok: false, text: "Failed to start sync" },
      }));
    } finally {
      setPulling(null);
    }
  };

  const handleDisconnect = async (id: string) => {
    setRemoving(id);
    try {
      await disconnect(id);
    } catch {
      // error surfaced via hook state
    } finally {
      setRemoving(null);
    }
  };

  /**
   * "Fix & reconnect" on a broken mailbox row. There is no in-place reconnect
   * — the connect route refuses a second active row for the same mailbox — so
   * this carries its settings (host, port, mailbox, ...) into the connect
   * form below, leaving only the password for the user to re-enter. The old
   * integration is disconnected in handleConnect, at submit time, not here:
   * a click that deletes the mailbox before a new password is even typed is
   * one accidental tap away from data loss.
   */
  const handleReconnect = (integration: EmailIntegration) => {
    setHost(integration.imapHost || "");
    setPort(String(integration.imapPort || 993));
    setSecure(integration.imapSecure ?? true);
    setUser(integration.email || "");
    setPassword("");
    setMailbox(integration.imapMailbox || "INBOX");
    setAllowSelfSigned(integration.imapAllowSelfSigned ?? false);
    setKeywordPrefilter(integration.imapKeywordPrefilter ?? true);
    setFormError(null);
    setSuccess(false);
    setReconnectTarget({ id: integration.id, email: integration.email });
    connectFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-2xl mx-auto p-6 space-y-6">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.push("/settings/integrations")}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-teal-100 dark:bg-teal-900/40 flex items-center justify-center">
              <Mail className="h-5 w-5 text-teal-600 dark:text-teal-400" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">IMAP Mailbox</h1>
              <p className="text-sm text-muted-foreground">
                Connect any mailbox (Migadu, Fastmail, dovecot, ...) with an app-password
              </p>
            </div>
          </div>
        </div>

        {/* Connected mailboxes */}
        {!loading && imapIntegrations.length > 0 && (
          <div className="space-y-2">
            {imapIntegrations.map((i) => (
              <ImapMailboxRow
                key={i.id}
                integration={i}
                pulling={pulling === i.id}
                removing={removing === i.id}
                result={pullResult[i.id]}
                onPull={handlePullFiles}
                onDisconnect={handleDisconnect}
                onReconnect={handleReconnect}
              />
            ))}
          </div>
        )}

        {/* Connect form */}
        <Card ref={connectFormRef}>
          <CardHeader>
            <CardTitle>Connect a mailbox</CardTitle>
            <CardDescription>
              Credentials are verified with a live login before anything is saved.
              The app-password is stored encrypted and used read-only.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleConnect} className="space-y-4">
              {reconnectTarget && !success && (
                <Alert>
                  <Info className="h-4 w-4" />
                  <AlertTitle>Reconnecting {reconnectTarget.email}</AlertTitle>
                  <AlertDescription>
                    Settings carried over — enter the new app-password and submit.
                    The broken mailbox is disconnected only once this succeeds.
                  </AlertDescription>
                </Alert>
              )}
              {success && (
                <Alert>
                  <Check className="h-4 w-4" />
                  <AlertTitle>Mailbox connected</AlertTitle>
                  <AlertDescription>
                    Syncing recent invoices now.
                  </AlertDescription>
                </Alert>
              )}
              {formError && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Could not connect</AlertTitle>
                  <AlertDescription>{formError}</AlertDescription>
                </Alert>
              )}

              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2 space-y-1.5">
                  <Label htmlFor="imap-host">IMAP host</Label>
                  <Input
                    id="imap-host"
                    placeholder="imap.migadu.com"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="imap-port">Port</Label>
                  <Input
                    id="imap-port"
                    inputMode="numeric"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    required
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="imap-user">Username / email</Label>
                <Input
                  id="imap-user"
                  type="email"
                  autoComplete="off"
                  placeholder="you@example.com"
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="imap-password">App-password</Label>
                <Input
                  id="imap-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>

              {/* Advanced */}
              <div className="space-y-3 rounded-lg border p-3">
                <div className="space-y-1.5">
                  <Label htmlFor="imap-mailbox">Mailbox</Label>
                  <Input
                    id="imap-mailbox"
                    value={mailbox}
                    onChange={(e) => setMailbox(e.target.value)}
                    placeholder="INBOX"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="imap-secure" className="cursor-pointer">
                    Implicit TLS (port 993)
                  </Label>
                  <Switch id="imap-secure" checked={secure} onCheckedChange={setSecure} />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="imap-self-signed" className="cursor-pointer">
                    Allow self-signed certificate
                  </Label>
                  <Switch
                    id="imap-self-signed"
                    checked={allowSelfSigned}
                    onCheckedChange={setAllowSelfSigned}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="imap-prefilter" className="cursor-pointer">
                    Keyword pre-filter (faster; disable if it misses invoices)
                  </Label>
                  <Switch
                    id="imap-prefilter"
                    checked={keywordPrefilter}
                    onCheckedChange={setKeywordPrefilter}
                  />
                </div>
              </div>

              <Button type="submit" disabled={connecting} className="w-full">
                {connecting ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Mail className="h-4 w-4 mr-2" />
                )}
                Connect mailbox
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

interface ImapMailboxRowProps {
  integration: EmailIntegration;
  pulling: boolean;
  removing: boolean;
  result?: { ok: boolean; text: string };
  onPull: (id: string) => void;
  onDisconnect: (id: string) => void;
  onReconnect: (integration: EmailIntegration) => void;
}

function ImapMailboxRow({
  integration,
  pulling,
  removing,
  result,
  onPull,
  onDisconnect,
  onReconnect,
}: ImapMailboxRowProps) {
  // Own hook call per row (not inside the parent's .map()), matching the
  // pattern GmailAccountCard uses for the same reason.
  const activeSync = useActiveSyncForIntegration(integration.id);
  const lastSyncAt = toDateSafe(integration.lastSyncAt);

  const errorCode = integration.lastSyncErrorCode;
  const errorMessage = errorCode ? IMAP_ERROR_MESSAGES[errorCode] : null;
  // Disable rather than hide: an auth or missing-mailbox failure cannot
  // resolve without reconnecting, so a press there is a promise the system
  // cannot keep. Every other outcome (unreachable, TLS, generic) stays
  // pressable — retrying is the correct response to those.
  const isFatalError = !!errorCode && FATAL_IMAP_ERROR_CODES.has(errorCode);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between rounded-lg border p-3">
        {/* The row body opens the mailbox's detail page — its import
            statistics, sync history, and pause/resume controls, which were
            reachable for Gmail accounts only because nothing linked here.
            The buttons to the right stay in place rather than joining the
            link, so a press does not navigate. */}
        <Link href={`/integrations/${integration.id}`} className="min-w-0 group">
          <div className="font-medium truncate group-hover:underline">
            {integration.email}
          </div>
          <div className="text-xs text-muted-foreground truncate">
            {integration.imapHost}:{integration.imapPort} ·{" "}
            {integration.imapMailbox || "INBOX"}
          </div>
          <div className="text-xs mt-1">
            {activeSync.isActive ? (
              <span className="flex items-center gap-1.5 text-blue-600 dark:text-blue-400">
                <Loader2 className="h-3 w-3 animate-spin" />
                Syncing...
                {activeSync.filesCreated > 0 && ` (${activeSync.filesCreated} files)`}
              </span>
            ) : lastSyncAt ? (
              <span className="text-muted-foreground">
                Last synced {formatDistanceToNow(lastSyncAt, { addSuffix: true })}
              </span>
            ) : (
              <span className="text-muted-foreground">Not synced yet</span>
            )}
          </div>
        </Link>
        <div className="flex items-center gap-2">
          {/* Hidden while paused or an active sync is running; disabled (not
              hidden) for a fatal classified error, matching the Gmail integration. */}
          {!integration.isPaused && !activeSync.isActive && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPull(integration.id)}
              disabled={pulling || isFatalError}
              title={isFatalError ? errorMessage ?? undefined : undefined}
            >
              {pulling ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              <span className="ml-2">Pull New Files</span>
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onDisconnect(integration.id)}
            disabled={removing}
            aria-label="Disconnect mailbox"
          >
            {removing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4 text-destructive" />
            )}
          </Button>
        </div>
      </div>

      {errorMessage && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>{errorMessage}</span>
            {isFatalError && (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => onReconnect(integration)}
                disabled={removing}
              >
                Fix &amp; reconnect
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {result && (
        <Alert variant={result.ok ? "default" : "destructive"}>
          {result.ok ? <Check className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
          <AlertDescription>{result.text}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
