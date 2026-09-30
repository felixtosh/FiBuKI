"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Mail,
  ArrowLeft,
  Loader2,
  Check,
  AlertCircle,
  Trash2,
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
import { ImapCredentialsDialog } from "@/components/integrations/imap-credentials-dialog";
import { useEmailIntegrations } from "@/hooks/use-email-integrations";
import { usePageTitle } from "@/hooks/use-page-title";
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

  // The mailbox "Fix & reconnect" is repairing, if any. The dialog it opens
  // updates the mailbox in place rather than replacing it, so the connect form
  // below is only ever used for genuinely new mailboxes.
  const [repairTarget, setRepairTarget] = useState<EmailIntegration | null>(null);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSuccess(false);
    setConnecting(true);
    try {
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
   * "Fix & reconnect" on a broken mailbox row.
   *
   * Repairs the mailbox in place through the credential route, which verifies
   * the new app-password before storing it. This replaces the old
   * disconnect-then-connect: that path had to delete the integration to get
   * around the connect route's duplicate check, and disconnect soft-deletes
   * every file from the mailbox not yet matched to a transaction — so fixing
   * a mistyped password cost the user their unmatched receipts.
   */
  const handleReconnect = (integration: EmailIntegration) => {
    setRepairTarget(integration);
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
                removing={removing === i.id}
                onDisconnect={handleDisconnect}
                onReconnect={handleReconnect}
              />
            ))}
          </div>
        )}

        {/* Connect form */}
        <Card>
          <CardHeader>
            <CardTitle>Connect a mailbox</CardTitle>
            <CardDescription>
              Credentials are verified with a live login before anything is saved.
              The app-password is stored encrypted and used read-only.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleConnect} className="space-y-4">
              {success && (
                <Alert>
                  <Check className="h-4 w-4" />
                  <AlertTitle>Mailbox connected</AlertTitle>
                  <AlertDescription>
                    Searching it for the receipts your open transactions are missing.
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

      {repairTarget && (
        <ImapCredentialsDialog
          integration={repairTarget}
          open={true}
          onOpenChange={(open) => {
            if (!open) setRepairTarget(null);
          }}
        />
      )}
    </div>
  );
}

interface ImapMailboxRowProps {
  integration: EmailIntegration;
  removing: boolean;
  onDisconnect: (id: string) => void;
  onReconnect: (integration: EmailIntegration) => void;
}

function ImapMailboxRow({
  integration,
  removing,
  onDisconnect,
  onReconnect,
}: ImapMailboxRowProps) {
  const errorCode = integration.lastSyncErrorCode;
  const errorMessage = errorCode ? IMAP_ERROR_MESSAGES[errorCode] : null;
  // An auth or missing-mailbox failure cannot resolve without reconnecting.
  const isFatalError = !!errorCode && FATAL_IMAP_ERROR_CODES.has(errorCode);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between rounded-lg border p-3">
        {/* The row body opens the mailbox's detail page. The buttons to the
            right stay outside the link, so a press does not navigate. */}
        <Link href={`/integrations/${integration.id}`} className="min-w-0 group">
          <div className="font-medium truncate group-hover:underline">
            {integration.email}
          </div>
          <div className="text-xs text-muted-foreground truncate">
            {integration.imapHost}:{integration.imapPort} ·{" "}
            {integration.imapMailbox || "INBOX"}
          </div>
        </Link>
        <div className="flex items-center gap-2">
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

    </div>
  );
}
