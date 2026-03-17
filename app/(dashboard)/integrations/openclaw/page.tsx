"use client";

import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  IntegrationSubPageLayout,
  ConfigBlock,
  SetupStep,
} from "@/components/integrations/developer-shared";
import { CopyableCommand } from "@/components/settings/api-key-primitives";

export default function OpenClawPage() {
  return (
    <IntegrationSubPageLayout
      title="OpenClaw Skill"
      description="Install FiBuKI as an OpenClaw skill for AI-powered bookkeeping"
    >
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Setup</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <SetupStep number={1} title="Install the skill">
            <div className="space-y-3">
              <div>
                <Badge variant="secondary" className="text-xs mb-2">Recommended</Badge>
                <CopyableCommand command="clawhub install fibuki" />
              </div>
              <div>
                <Badge variant="outline" className="text-xs mb-2">Alternative: npm</Badge>
                <CopyableCommand command="openclaw plugins install @fibukiapp/openclaw-plugin" />
              </div>
            </div>
          </SetupStep>

          <SetupStep number={2} title="Authenticate">
            <p className="text-sm text-muted-foreground">
              Run the CLI auth command to create and save your API key automatically.
            </p>
            <CopyableCommand command="npx @fibukiapp/cli auth" />
          </SetupStep>

          <SetupStep number={3} title="Or configure manually">
            <p className="text-sm text-muted-foreground">
              Add your API key to the OpenClaw config file:
            </p>
            <ConfigBlock
              label="~/.openclaw/openclaw.json"
              code={`{
  "skills": {
    "entries": {
      "fibuki": {
        "enabled": true,
        "env": { "FIBUKI_API_KEY": "fk_xxx" }
      }
    }
  }
}`}
            />
          </SetupStep>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What You Get</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-3">
            The FiBuKI skill gives your OpenClaw agent access to all bookkeeping tools:
            browsing bank transactions, uploading and matching receipts, managing partners
            and categories, and driving completion to 100%.
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href="https://clawhub.ai" target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3 w-3 mr-1.5" />
                ClawHub
              </a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href="https://fibuki.com/llm.txt" target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3 w-3 mr-1.5" />
                llm.txt
              </a>
            </Button>
          </div>
        </CardContent>
      </Card>
    </IntegrationSubPageLayout>
  );
}
