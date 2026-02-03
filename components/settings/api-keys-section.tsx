"use client";

import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  Bot,
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { useApiKeys, ApiKey } from "@/hooks/use-api-keys";

export function ApiKeysSection() {
  const { keys, loading, error, createKey, revokeKey } = useApiKeys();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isKeyShownDialog, setIsKeyShownDialog] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyValue, setNewKeyValue] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);

  const handleCreate = async () => {
    if (!newKeyName.trim()) return;

    setCreating(true);
    setCreateError(null);

    try {
      const result = await createKey(newKeyName.trim());
      setNewKeyValue(result.key);
      setIsCreateDialogOpen(false);
      setIsKeyShownDialog(true);
      setNewKeyName("");
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create API key");
    } finally {
      setCreating(false);
    }
  };

  const handleCopyKey = async () => {
    await navigator.clipboard.writeText(newKeyValue);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  };

  const handleRevoke = async (keyId: string) => {
    setRevokingId(keyId);
    try {
      await revokeKey(keyId);
    } finally {
      setRevokingId(null);
    }
  };

  const handleCloseKeyDialog = () => {
    setIsKeyShownDialog(false);
    setNewKeyValue("");
    setShowKey(false);
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-violet-100 flex items-center justify-center">
                <Bot className="h-5 w-5 text-violet-600" />
              </div>
              <div>
                <CardTitle className="text-lg">AI Agents</CardTitle>
                <CardDescription>
                  Let AI assistants manage your transactions and receipts
                </CardDescription>
              </div>
            </div>
            <Button onClick={() => setIsCreateDialogOpen(true)} disabled={keys.length >= 5}>
              <Plus className="h-4 w-4 mr-2" />
              Create API Key
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {loading ? (
            <div className="text-center py-8 text-muted-foreground">
              <Loader2 className="h-6 w-6 mx-auto animate-spin mb-2" />
              Loading API keys...
            </div>
          ) : keys.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground border rounded-lg">
              <Key className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No API keys yet</p>
              <p className="text-xs mt-1">
                Create an API key to connect AI tools like OpenClaw or Claude Desktop
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {keys.map((key) => (
                <ApiKeyRow
                  key={key.id}
                  apiKey={key}
                  onRevoke={() => handleRevoke(key.id)}
                  revoking={revokingId === key.id}
                />
              ))}
            </div>
          )}

          {/* Integration Endpoints */}
          <div className="pt-4 border-t space-y-4">
            <div className="text-sm font-medium">Connect Your AI</div>

            {/* OpenClaw */}
            <IntegrationEndpoint
              name="OpenClaw Plugin"
              description="Install via npm and configure with your API key"
              endpoint="npm install @fibukiapp/openclaw-plugin"
              configExample={`{ "fibuki": { "config": { "apiKey": "fk_xxx" } } }`}
              docsUrl="https://www.npmjs.com/package/@fibukiapp/openclaw-plugin"
            />

            {/* Claude MCP */}
            <IntegrationEndpoint
              name="Claude Desktop (MCP)"
              description="Add to your Claude Desktop MCP config"
              endpoint="https://fibuki.com/api/mcp/sse"
              configExample={`{ "mcpServers": { "fibuki": { "url": "https://fibuki.com/api/mcp/sse", "headers": { "Authorization": "Bearer fk_xxx" } } } }`}
              docsUrl="https://modelcontextprotocol.io/quickstart"
            />

            {/* ChatGPT */}
            <IntegrationEndpoint
              name="ChatGPT Custom GPT"
              description="Import OpenAPI spec when creating a GPT action"
              endpoint="https://fibuki.com/api/openapi.json"
              configExample="Auth: API Key (Bearer) → Enter your fk_xxx key"
              docsUrl="https://platform.openai.com/docs/actions"
            />

            {/* REST API */}
            <IntegrationEndpoint
              name="REST API"
              description="Direct HTTP access for custom integrations"
              endpoint="https://fibuki.com/api/mcp"
              configExample={`curl -X POST https://fibuki.com/api/mcp -H "Authorization: Bearer fk_xxx" -d '{"tool":"list_transactions"}'`}
            />
          </div>
        </CardContent>
      </Card>

      {/* Create Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
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
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                A descriptive name to identify this key
              </p>
            </div>

            {createError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{createError}</AlertDescription>
              </Alert>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={!newKeyName.trim() || creating}>
              {creating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create Key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Key Shown Dialog */}
      <Dialog open={isKeyShownDialog} onOpenChange={handleCloseKeyDialog}>
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
                    value={showKey ? newKeyValue : "•".repeat(newKeyValue.length)}
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
                <Button onClick={handleCopyKey}>
                  {copiedKey ? (
                    <Check className="h-4 w-4 text-green-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button onClick={handleCloseKeyDialog}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ApiKeyRow({
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
                  • Last used{" "}
                  {formatDistanceToNow(new Date(apiKey.lastUsedAt), { addSuffix: true })}
                </>
              )}
              {apiKey.usageCount > 0 && <> • {apiKey.usageCount} requests</>}
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

function IntegrationEndpoint({
  name,
  description,
  endpoint,
  configExample,
  docsUrl,
}: {
  name: string;
  description: string;
  endpoint: string;
  configExample: string;
  docsUrl?: string;
}) {
  const [copiedEndpoint, setCopiedEndpoint] = useState(false);
  const [copiedConfig, setCopiedConfig] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const copyEndpoint = async () => {
    await navigator.clipboard.writeText(endpoint);
    setCopiedEndpoint(true);
    setTimeout(() => setCopiedEndpoint(false), 2000);
  };

  const copyConfig = async () => {
    await navigator.clipboard.writeText(configExample);
    setCopiedConfig(true);
    setTimeout(() => setCopiedConfig(false), 2000);
  };

  return (
    <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium text-sm">{name}</div>
          <div className="text-xs text-muted-foreground">{description}</div>
        </div>
        <div className="flex items-center gap-1">
          {docsUrl && (
            <Button variant="ghost" size="sm" asChild>
              <a href={docsUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Hide" : "Show"}
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="space-y-2 pt-2 border-t">
          <div>
            <Label className="text-xs">Endpoint</Label>
            <div className="flex gap-2 mt-1">
              <code className="flex-1 text-xs bg-background px-2 py-1.5 rounded border overflow-x-auto">
                {endpoint}
              </code>
              <Button variant="outline" size="sm" onClick={copyEndpoint}>
                {copiedEndpoint ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </Button>
            </div>
          </div>

          <div>
            <Label className="text-xs">Configuration Example</Label>
            <div className="flex gap-2 mt-1">
              <pre className="flex-1 text-xs bg-background px-2 py-1.5 rounded border overflow-x-auto whitespace-pre-wrap">
                {configExample}
              </pre>
              <Button variant="outline" size="sm" onClick={copyConfig}>
                {copiedConfig ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
