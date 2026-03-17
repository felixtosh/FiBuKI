"use client";

import { useState } from "react";
import {
  Bot,
  Plus,
  Key,
  Loader2,
  AlertCircle,
  ExternalLink,
  Terminal,
  FileText,
  BookOpen,
  Copy,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useApiKeys } from "@/hooks/use-api-keys";
import {
  ApiKeyRow,
  CopyableCommand,
  CreateApiKeyDialog,
  KeyShownDialog,
  ResourceLink,
} from "@/components/settings/api-key-primitives";

export function ApiKeysSection() {
  const { keys, loading, error, createKey, revokeKey } = useApiKeys();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isKeyShownDialog, setIsKeyShownDialog] = useState(false);
  const [newKeyValue, setNewKeyValue] = useState("");
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const handleRevoke = async (keyId: string) => {
    setRevokingId(keyId);
    try {
      await revokeKey(keyId);
    } finally {
      setRevokingId(null);
    }
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

          {/* Quick Setup */}
          <div className="pt-4 border-t space-y-4">
            <div className="text-sm font-medium">Quick Setup</div>
            <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
              <div className="flex items-start gap-3">
                <div className="h-8 w-8 rounded-md bg-emerald-100 flex items-center justify-center shrink-0 mt-0.5">
                  <Terminal className="h-4 w-4 text-emerald-700" />
                </div>
                <div className="space-y-1.5 min-w-0">
                  <div className="font-medium text-sm">CLI Authentication</div>
                  <p className="text-xs text-muted-foreground">
                    Create an API key from your terminal — no manual copy-paste needed.
                    Opens your browser for approval, then saves the key automatically.
                  </p>
                  <CopyableCommand command="npx @fibukiapp/cli auth" />
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Badge variant="secondary" className="text-[10px] font-normal">
                      --format mcp &nbsp;&rarr; Claude Desktop config
                    </Badge>
                    <Badge variant="secondary" className="text-[10px] font-normal">
                      --format env &nbsp;&rarr; FIBUKI_API_KEY=fk_...
                    </Badge>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Integration Endpoints */}
          <div className="pt-4 border-t space-y-4">
            <div className="text-sm font-medium">Connect Your AI</div>

            {/* OpenClaw */}
            <IntegrationEndpoint
              name="OpenClaw Skill"
              description="Install from ClawHub or npm — includes domain guide + all tools"
              endpoint="clawhub install fibuki"
              configExample={`# ClawHub (recommended)\nclawhub install fibuki\n\n# Or via npm plugin\nopenclaw plugins install @fibukiapp/openclaw-plugin\n\n# Then add your API key to ~/.openclaw/openclaw.json:\n{\n  "skills": {\n    "entries": {\n      "fibuki": {\n        "enabled": true,\n        "env": { "FIBUKI_API_KEY": "fk_xxx" }\n      }\n    }\n  }\n}`}
              docsUrl="https://clawhub.ai"
            />

            {/* Claude MCP */}
            <IntegrationEndpoint
              name="Claude Desktop (MCP)"
              description="Add to your Claude Desktop MCP config"
              endpoint="https://fibuki.com/api/mcp/sse"
              configExample={`{\n  "mcpServers": {\n    "fibuki": {\n      "url": "https://fibuki.com/api/mcp/sse",\n      "headers": {\n        "Authorization": "Bearer fk_xxx"\n      }\n    }\n  }\n}`}
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
              configExample={`curl -X POST https://fibuki.com/api/mcp \\\n  -H "Authorization: Bearer fk_xxx" \\\n  -H "Content-Type: application/json" \\\n  -d '{"tool":"list_transactions","arguments":{"isComplete":false,"limit":5}}'`}
            />
          </div>

          {/* Resources */}
          <div className="pt-4 border-t space-y-3">
            <div className="text-sm font-medium">Resources</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <ResourceLink
                icon={<BookOpen className="h-4 w-4" />}
                label="llm.txt"
                description="Machine-readable API overview for AI agents"
                href="https://fibuki.com/llm.txt"
              />
              <ResourceLink
                icon={<FileText className="h-4 w-4" />}
                label="OpenAPI Spec"
                description="Full tool schema for GPT Actions"
                href="https://fibuki.com/api/openapi.json"
              />
              <ResourceLink
                icon={<Terminal className="h-4 w-4" />}
                label="CLI on npm"
                description="@fibukiapp/cli package"
                href="https://www.npmjs.com/package/@fibukiapp/cli"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <CreateApiKeyDialog
        open={isCreateDialogOpen}
        onOpenChange={setIsCreateDialogOpen}
        onCreated={(key) => {
          setNewKeyValue(key);
          setIsKeyShownDialog(true);
        }}
        createKey={createKey}
        keyCount={keys.length}
      />

      <KeyShownDialog
        open={isKeyShownDialog}
        onClose={() => {
          setIsKeyShownDialog(false);
          setNewKeyValue("");
        }}
        keyValue={newKeyValue}
      />
    </>
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
