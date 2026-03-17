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

export default function ClaudeMcpPage() {
  return (
    <IntegrationSubPageLayout
      title="Claude Desktop (MCP)"
      description="Connect FiBuKI to Claude Desktop via the Model Context Protocol"
    >
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Setup</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <SetupStep number={1} title="Get your API key">
            <p className="text-sm text-muted-foreground">
              The CLI can generate your key and output the MCP config in one step:
            </p>
            <CopyableCommand command="npx @fibukiapp/cli auth --format mcp" />
            <p className="text-xs text-muted-foreground">
              This outputs the JSON snippet you can paste directly into your Claude Desktop config.
            </p>
          </SetupStep>

          <SetupStep number={2} title="Add to Claude Desktop config">
            <p className="text-sm text-muted-foreground">
              Add this to your <code className="text-xs bg-muted px-1 rounded">claude_desktop_config.json</code>:
            </p>
            <ConfigBlock
              label="claude_desktop_config.json"
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
          </SetupStep>

          <SetupStep number={3} title="Restart Claude Desktop">
            <p className="text-sm text-muted-foreground">
              After saving the config, restart Claude Desktop. You should see FiBuKI
              listed as an available MCP server with all bookkeeping tools.
            </p>
          </SetupStep>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Endpoint Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">MCP Endpoint</span>
            <code className="text-xs bg-muted px-2 py-0.5 rounded">https://fibuki.com/api/mcp/sse</code>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Protocol</span>
            <span className="font-medium">SSE (Server-Sent Events)</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Auth</span>
            <code className="text-xs bg-muted px-2 py-0.5 rounded">Bearer fk_...</code>
          </div>
          <div className="pt-2">
            <Button variant="outline" size="sm" asChild>
              <a href="https://modelcontextprotocol.io/quickstart" target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3 w-3 mr-1.5" />
                MCP Documentation
              </a>
            </Button>
          </div>
        </CardContent>
      </Card>
    </IntegrationSubPageLayout>
  );
}
