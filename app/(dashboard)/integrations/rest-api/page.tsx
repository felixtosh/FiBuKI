"use client";

import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  IntegrationSubPageLayout,
  ConfigBlock,
  SetupStep,
} from "@/components/integrations/developer-shared";
import { CopyableCommand } from "@/components/settings/api-key-primitives";

export default function RestApiPage() {
  return (
    <IntegrationSubPageLayout
      title="REST API"
      description="Direct HTTP access to all FiBuKI tools"
    >
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quick Start</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <SetupStep number={1} title="Get your API key">
            <CopyableCommand command="npx @fibukiapp/cli auth" />
          </SetupStep>

          <SetupStep number={2} title="Make your first request">
            <p className="text-sm text-muted-foreground">
              All tools are accessible via a single POST endpoint:
            </p>
            <ConfigBlock
              label="List bank accounts"
              code={`curl -X POST https://fibuki.com/api/mcp \\
  -H "Authorization: Bearer fk_xxx" \\
  -H "Content-Type: application/json" \\
  -d '{"tool": "list_sources"}'`}
              language="bash"
            />
          </SetupStep>

          <SetupStep number={3} title="Explore more tools">
            <p className="text-sm text-muted-foreground">
              See <a href="https://fibuki.com/llm.txt" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">llm.txt</a> for
              the full list of available tools and their parameters.
            </p>
          </SetupStep>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Request Format</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ConfigBlock
            label="Request"
            code={`POST https://fibuki.com/api/mcp
Authorization: Bearer fk_xxx
Content-Type: application/json

{
  "tool": "<tool_name>",
  "arguments": { ... }
}`}
            language="http"
          />

          <ConfigBlock
            label="Response"
            code={`{
  "content": [
    {
      "type": "text",
      "text": "{ ... tool result as JSON string ... }"
    }
  ]
}`}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Examples</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ConfigBlock
            label="List incomplete transactions"
            code={`curl -X POST https://fibuki.com/api/mcp \\
  -H "Authorization: Bearer fk_xxx" \\
  -H "Content-Type: application/json" \\
  -d '{"tool": "list_transactions", "arguments": {"isComplete": false, "limit": 5}}'`}
            language="bash"
          />

          <ConfigBlock
            label="Connect a file to a transaction"
            code={`curl -X POST https://fibuki.com/api/mcp \\
  -H "Authorization: Bearer fk_xxx" \\
  -H "Content-Type: application/json" \\
  -d '{"tool": "connect_file_to_transaction", "arguments": {"fileId": "abc", "transactionId": "xyz"}}'`}
            language="bash"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Endpoint Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">REST Endpoint</span>
            <code className="text-xs bg-muted px-2 py-0.5 rounded">POST fibuki.com/api/mcp</code>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">MCP (SSE)</span>
            <code className="text-xs bg-muted px-2 py-0.5 rounded">fibuki.com/api/mcp/sse</code>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Auth</span>
            <code className="text-xs bg-muted px-2 py-0.5 rounded">Bearer fk_...</code>
          </div>
          <div className="pt-2 flex gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href="https://fibuki.com/llm.txt" target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3 w-3 mr-1.5" />
                llm.txt
              </a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href="https://fibuki.com/api/openapi.json" target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3 w-3 mr-1.5" />
                OpenAPI Spec
              </a>
            </Button>
          </div>
        </CardContent>
      </Card>
    </IntegrationSubPageLayout>
  );
}
