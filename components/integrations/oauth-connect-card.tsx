"use client";

import { useTranslations } from "next-intl";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SetupStep } from "@/components/integrations/developer-shared";
import { CopyableCommand } from "@/components/settings/api-key-primitives";

/** The MCP endpoint the assistant connects to. Same on every deployment of fibuki.com. */
const MCP_URL = "https://fibuki.com/api/mcp/sse";

/**
 * Connecting an assistant without an API key: the user adds the server URL, signs in to FiBuKI
 * in the window the assistant opens, and approves. The API-key setup further down the page stays
 * as the alternative for tools that cannot do OAuth.
 */
export function OAuthConnectCard({ app }: { app: "chatgpt" | "claude" }) {
  const t = useTranslations("integrations.connect");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <SetupStep number={1} title={t(`${app}.step1`)}>
          <p className="text-sm text-muted-foreground">{t(`${app}.step1Detail`)}</p>
        </SetupStep>

        <SetupStep number={2} title={t(`${app}.step2`)}>
          <CopyableCommand command={MCP_URL} />
        </SetupStep>

        <SetupStep number={3} title={t("signInStep")}>
          <p className="text-sm text-muted-foreground">{t("signInDetail")}</p>
        </SetupStep>
      </CardContent>
    </Card>
  );
}
