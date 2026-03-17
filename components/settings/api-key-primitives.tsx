"use client";

import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  Plus,
  Key,
  Trash2,
  Copy,
  Check,
  Loader2,
  AlertCircle,
  ExternalLink,
  Eye,
  EyeOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type ApiKey } from "@/hooks/use-api-keys";

// --- ApiKeyRow ---

export function ApiKeyRow({
  apiKey,
  onRevoke,
  revoking,
}: {
  apiKey: ApiKey;
  onRevoke: () => void;
  revoking: boolean;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
            <Key className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium">{apiKey.name}</span>
              <code className="text-xs bg-muted px-2 py-0.5 rounded">{apiKey.keyPrefix}...</code>
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              Created {formatDistanceToNow(new Date(apiKey.createdAt), { addSuffix: true })}
              {apiKey.lastUsedAt && (
                <>
                  {" "}
                  &middot; Last used{" "}
                  {formatDistanceToNow(new Date(apiKey.lastUsedAt), { addSuffix: true })}
                </>
              )}
              {apiKey.usageCount > 0 && <> &middot; {apiKey.usageCount} requests</>}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {apiKey.expiresAt && (
            <Badge variant="secondary" className="text-xs">
              Expires {formatDistanceToNow(new Date(apiKey.expiresAt), { addSuffix: true })}
            </Badge>
          )}
          <Button variant="ghost" size="sm" onClick={onRevoke} disabled={revoking}>
            {revoking ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4 text-destructive" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

// --- Compact ApiKeyRow for inline usage ---

export function ApiKeyRowCompact({
  apiKey,
  onRevoke,
  revoking,
}: {
  apiKey: ApiKey;
  onRevoke: () => void;
  revoking: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm font-medium truncate">{apiKey.name}</span>
        <code className="text-xs bg-muted px-1.5 py-0.5 rounded shrink-0">{apiKey.keyPrefix}...</code>
        {apiKey.lastUsedAt && (
          <span className="text-xs text-muted-foreground shrink-0 hidden sm:inline">
            {formatDistanceToNow(new Date(apiKey.lastUsedAt), { addSuffix: true })}
          </span>
        )}
      </div>
      <Button variant="ghost" size="sm" onClick={onRevoke} disabled={revoking} className="shrink-0 h-7 w-7 p-0">
        {revoking ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Trash2 className="h-3.5 w-3.5 text-destructive" />
        )}
      </Button>
    </div>
  );
}

// --- CopyableCommand ---

export function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex gap-2">
      <code className="flex-1 text-xs font-mono bg-background px-3 py-2 rounded border">
        {command}
      </code>
      <Button variant="outline" size="sm" onClick={handleCopy} className="shrink-0">
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </Button>
    </div>
  );
}

// --- CreateApiKeyDialog ---

export function CreateApiKeyDialog({
  open,
  onOpenChange,
  onCreated,
  createKey,
  maxKeys = 5,
  keyCount = 0,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (key: string) => void;
  createKey: (name: string) => Promise<{ key: string }>;
  maxKeys?: number;
  keyCount?: number;
}) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!name.trim()) return;

    setCreating(true);
    setError(null);

    try {
      const result = await createKey(name.trim());
      onCreated(result.key);
      onOpenChange(false);
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create API key");
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create API Key</DialogTitle>
          <DialogDescription>
            Create an API key to connect AI tools to your FiBuKI account.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="keyName">Key Name</Label>
            <Input
              id="keyName"
              placeholder="e.g., OpenClaw, Claude Desktop"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              A descriptive name to identify this key
            </p>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!name.trim() || creating || keyCount >= maxKeys}
          >
            {creating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Create Key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- KeyShownDialog ---

export function KeyShownDialog({
  open,
  onClose,
  keyValue,
}: {
  open: boolean;
  onClose: () => void;
  keyValue: string;
}) {
  const [copied, setCopied] = useState(false);
  const [showKey, setShowKey] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(keyValue);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleClose = () => {
    setShowKey(false);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>API Key Created</DialogTitle>
          <DialogDescription>
            Copy your API key now. You won&apos;t be able to see it again.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              This is the only time you&apos;ll see this key. Copy it now and store it securely.
            </AlertDescription>
          </Alert>

          <div className="space-y-2">
            <Label>Your API Key</Label>
            <div className="flex gap-2">
              <div className="flex-1 relative">
                <Input
                  readOnly
                  value={showKey ? keyValue : "\u2022".repeat(keyValue.length)}
                  className="font-mono text-sm pr-10"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="absolute right-1 top-1 h-7 w-7 p-0"
                  onClick={() => setShowKey(!showKey)}
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              <Button onClick={handleCopy}>
                {copied ? (
                  <Check className="h-4 w-4 text-green-500" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={handleClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- ResourceLink ---

export function ResourceLink({
  icon,
  label,
  description,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  href: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-start gap-2.5 rounded-lg border bg-muted/30 p-3 hover:bg-muted/50 transition-colors"
    >
      <div className="text-muted-foreground mt-0.5 shrink-0">{icon}</div>
      <div className="min-w-0">
        <div className="text-sm font-medium flex items-center gap-1">
          {label}
          <ExternalLink className="h-3 w-3 text-muted-foreground" />
        </div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
    </a>
  );
}

// --- CreateKeyButton (compact for inline usage) ---

export function CreateKeyButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button size="sm" variant="outline" onClick={onClick} disabled={disabled} className="h-7 text-xs">
      <Plus className="h-3 w-3 mr-1" />
      Create Key
    </Button>
  );
}
