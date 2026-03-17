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

export default function ChatGptPage() {
  return (
    <IntegrationSubPageLayout
      title="ChatGPT Custom GPT"
      description="Add FiBuKI as an action in your Custom GPT"
    >
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Setup</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <SetupStep number={1} title="Import the OpenAPI spec">
            <p className="text-sm text-muted-foreground">
              In the GPT Builder, go to <strong>Configure &rarr; Actions &rarr; Create new action</strong>.
              Click &ldquo;Import from URL&rdquo; and paste:
            </p>
            <CopyableCommand command="https://fibuki.com/api/openapi.json" />
          </SetupStep>

          <SetupStep number={2} title="Configure authentication">
            <p className="text-sm text-muted-foreground">
              Set up API Key authentication in the GPT action settings:
            </p>
            <ConfigBlock
              label="Authentication settings"
              code={`Authentication type: API Key
API Key: fk_xxx
Auth Type: Bearer`}
              language="text"
            />
          </SetupStep>

          <SetupStep number={3} title="Test the action">
            <p className="text-sm text-muted-foreground">
              Try asking your GPT to list your bank accounts or show recent transactions.
              The GPT will call FiBuKI&apos;s API automatically.
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
            <span className="text-muted-foreground">OpenAPI Spec</span>
            <code className="text-xs bg-muted px-2 py-0.5 rounded">fibuki.com/api/openapi.json</code>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Auth</span>
            <span className="font-medium">API Key (Bearer)</span>
          </div>
          <div className="pt-2 flex gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href="https://fibuki.com/api/openapi.json" target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3 w-3 mr-1.5" />
                OpenAPI Spec
              </a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href="https://platform.openai.com/docs/actions" target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3 w-3 mr-1.5" />
                GPT Actions Docs
              </a>
            </Button>
          </div>
        </CardContent>
      </Card>
    </IntegrationSubPageLayout>
  );
}
