"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function CopyBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative">
      <pre className="text-sm bg-muted rounded-lg px-4 py-3 overflow-x-auto whitespace-pre-wrap font-mono">
        {code}
      </pre>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleCopy}
        className="absolute top-2 right-2 h-7 text-xs gap-1"
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </Button>
    </div>
  );
}

export function IntegrationMethodTabs() {
  return (
    <Tabs defaultValue="openclaw" className="w-full">
      <TabsList className="w-full grid grid-cols-4">
        <TabsTrigger value="openclaw">OpenClaw</TabsTrigger>
        <TabsTrigger value="claude">Claude</TabsTrigger>
        <TabsTrigger value="chatgpt">ChatGPT</TabsTrigger>
        <TabsTrigger value="rest">REST API</TabsTrigger>
      </TabsList>

      <TabsContent value="openclaw" className="mt-4 space-y-3">
        <p className="text-sm text-muted-foreground">
          Install the FiBuKI skill and paste your API key into the conversation.
        </p>
        <CopyBlock code="clawhub install fibuki" />
        <p className="text-xs text-muted-foreground">
          Or via npm: <code className="bg-muted px-1 rounded">openclaw plugins install @fibukiapp/openclaw-plugin</code>
        </p>
      </TabsContent>

      <TabsContent value="claude" className="mt-4 space-y-3">
        <p className="text-sm text-muted-foreground">
          Add FiBuKI to your Claude Desktop MCP config:
        </p>
        <CopyBlock
          code={`{
  "mcpServers": {
    "fibuki": {
      "url": "https://fibuki.com/api/mcp/sse",
      "headers": {
        "Authorization": "Bearer fk_xxx"
      }
    }
  }
}`}
        />
        <p className="text-xs text-muted-foreground">
          Shortcut: <code className="bg-muted px-1 rounded">npx @fibukiapp/cli auth --format mcp</code>
        </p>
      </TabsContent>

      <TabsContent value="chatgpt" className="mt-4 space-y-3">
        <p className="text-sm text-muted-foreground">
          In GPT Builder, go to Configure &rarr; Actions &rarr; Import from URL:
        </p>
        <CopyBlock code="https://fibuki.com/api/openapi.json" />
        <p className="text-xs text-muted-foreground">
          Set authentication to API Key (Bearer) and enter your <code className="bg-muted px-1 rounded">fk_</code> key.
        </p>
      </TabsContent>

      <TabsContent value="rest" className="mt-4 space-y-3">
        <p className="text-sm text-muted-foreground">
          Make HTTP requests directly to the REST endpoint:
        </p>
        <CopyBlock
          code={`curl -X POST https://fibuki.com/api/mcp \\
  -H "Authorization: Bearer fk_xxx" \\
  -H "Content-Type: application/json" \\
  -d '{"tool":"list_transactions","arguments":{"isComplete":false,"limit":5}}'`}
        />
      </TabsContent>
    </Tabs>
  );
}
