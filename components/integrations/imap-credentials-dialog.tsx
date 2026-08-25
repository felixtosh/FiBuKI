"use client";

import { useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEmailIntegrations } from "@/hooks/use-email-integrations";
import { EmailIntegration } from "@/types/email-integration";

interface ImapCredentialsDialogProps {
  integration: EmailIntegration;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the mailbox has been repaired. */
  onRepaired?: () => void;
}

/**
 * Repair a broken IMAP mailbox by entering a new app-password.
 *
 * This is IMAP's answer to Gmail's "sign in with Google again": the same
 * intent, reached the same way, expressed in the only terms a mailbox
 * authenticating with an app-password can be repaired in. Both the mailbox row
 * and the integration detail page open it, so there is one repair path with
 * one set of consequences rather than two.
 *
 * The connection settings are shown because a mailbox can break by moving as
 * well as by having its password revoked, but they default to what is already
 * stored: the common repair changes only the password.
 */
export function ImapCredentialsDialog({
  integration,
  open,
  onOpenChange,
  onRepaired,
}: ImapCredentialsDialogProps) {
  const { repairImapCredentials } = useEmailIntegrations();

  const [password, setPassword] = useState("");
  const [host, setHost] = useState(integration.imapHost || "");
  const [port, setPort] = useState(String(integration.imapPort || 993));
  const [mailbox, setMailbox] = useState(integration.imapMailbox || "INBOX");
  const [secure, setSecure] = useState(integration.imapSecure ?? true);
  const [allowSelfSigned, setAllowSelfSigned] = useState(
    integration.imapAllowSelfSigned ?? false
  );
  const [showSettings, setShowSettings] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await repairImapCredentials({
        integrationId: integration.id,
        password,
        host: host.trim(),
        port: Number(port) || 993,
        secure,
        mailbox: mailbox.trim() || "INBOX",
        allowSelfSigned,
      });
      setPassword("");
      onOpenChange(false);
      onRepaired?.();
    } catch (err) {
      // The route verifies before it stores, so a failure here means the
      // mailbox is exactly as it was. Say what went wrong and stay open.
      setError(err instanceof Error ? err.message : "Failed to update credentials");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Reconnect {integration.email}</DialogTitle>
            <DialogDescription>
              Enter a new app-password. It is verified with a live login before
              anything is saved, and your imported files and sync history are
              kept either way.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="repair-password">App-password</Label>
              <Input
                id="repair-password"
                type="password"
                autoComplete="new-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            {showSettings ? (
              <div className="space-y-3 rounded-lg border p-3">
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2 space-y-1.5">
                    <Label htmlFor="repair-host">IMAP host</Label>
                    <Input
                      id="repair-host"
                      value={host}
                      onChange={(e) => setHost(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="repair-port">Port</Label>
                    <Input
                      id="repair-port"
                      inputMode="numeric"
                      value={port}
                      onChange={(e) => setPort(e.target.value)}
                      required
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="repair-mailbox">Mailbox</Label>
                  <Input
                    id="repair-mailbox"
                    value={mailbox}
                    onChange={(e) => setMailbox(e.target.value)}
                    placeholder="INBOX"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="repair-secure" className="cursor-pointer">
                    Implicit TLS (port 993)
                  </Label>
                  <Switch
                    id="repair-secure"
                    checked={secure}
                    onCheckedChange={setSecure}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="repair-self-signed" className="cursor-pointer">
                    Allow self-signed certificate
                  </Label>
                  <Switch
                    id="repair-self-signed"
                    checked={allowSelfSigned}
                    onCheckedChange={setAllowSelfSigned}
                  />
                </div>
              </div>
            ) : (
              <Button
                type="button"
                variant="link"
                className="h-auto p-0 text-xs"
                onClick={() => setShowSettings(true)}
              >
                Server settings changed too?
              </Button>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !password}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Reconnect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
