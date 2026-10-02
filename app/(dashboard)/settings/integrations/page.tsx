"use client";

import { Suspense, useMemo } from "react";
import Link from "next/link";
import {
  Mail,
  AlertCircle,
  Loader2,
  Globe,
  Inbox,
  FileText,
  Code,
  BookOpen,
  Terminal,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useTranslations } from "next-intl";
import { useEmailIntegrations } from "@/hooks/use-email-integrations";
import { useFolderIntegrations } from "@/hooks/use-folder-integrations";
import { useBrowserExtensionStatus } from "@/hooks/use-browser-extension";
import { useEmailInbound } from "@/hooks/use-email-inbound";
import { useAuth } from "@/components/auth/auth-provider";
import { SmartFeatureGuard } from "@/components/auth";
import { useUserData } from "@/hooks/use-user-data";
import { SettingsPageHeader } from "@/components/ui/settings-page-header";
import { IntegrationCard } from "@/components/integrations/integration-card";
import {
  BmdLogo,
  ClaudeLogo,
  DropboxLogo,
  FinanzOnlineLogo,
  GmailLogo,
  GoogleDriveLogo,
  OpenAILogo,
  OpenClawLogo,
  OutlookLogo,
} from "@/components/integrations/brand-logos";
import { ApiKeysInline } from "@/components/settings/api-keys-inline";
import { ResourceLink } from "@/components/settings/api-key-primitives";

interface AttentionItem {
  message: string;
  href: string;
}

function IntegrationsContent() {
  const tFolder = useTranslations("folderIntegrations");
  const tSections = useTranslations("integrationSections");
  const { integrations: dropboxIntegrations, loading: dropboxLoading } = useFolderIntegrations("dropbox");
  const { integrations: gdriveIntegrations, loading: gdriveLoading } = useFolderIntegrations("gdrive");
  const extension = useBrowserExtensionStatus();
  const { integrations, loading: gmailLoading } = useEmailIntegrations();
  const { primaryAddress } = useEmailInbound();
  const { isAdmin } = useAuth();
  const { userData } = useUserData();
  const gmailIntegrations = integrations.filter((i) => i.provider === "gmail");
  const imapIntegrations = integrations.filter((i) => i.provider === "imap");

  // --- Derive status strings ---
  const extensionStatus =
    extension.status === "checking"
      ? "Checking..."
      : extension.status === "installed"
        ? "Extension connected and ready"
        : "Not installed";

  const extensionBadge =
    extension.status === "installed"
      ? ({ label: "Installed", variant: "success" as const })
      : undefined;

  const gmailStatus = gmailLoading
    ? "Loading..."
    : gmailIntegrations.length === 0
      ? "No accounts connected"
      : gmailIntegrations.length === 1
        ? "1 account"
        : `${gmailIntegrations.length} accounts`;

  const gmailNeedsAttention = gmailIntegrations.some(
    (i) => i.needsReauth || i.lastSyncStatus === "failed"
  );

  const gmailBadge = gmailNeedsAttention
    ? ({ label: "Action needed", variant: "destructive" as const })
    : gmailIntegrations.length > 0
      ? ({ label: "Connected", variant: "success" as const })
      : undefined;

  const imapStatus = gmailLoading
    ? "Loading..."
    : imapIntegrations.length === 0
      ? "Connect any IMAP mailbox"
      : imapIntegrations.length === 1
        ? "1 mailbox"
        : `${imapIntegrations.length} mailboxes`;

  const imapNeedsAttention = imapIntegrations.some(
    (i) => i.needsReauth || i.lastSyncStatus === "failed"
  );

  const imapBadge = imapNeedsAttention
    ? ({ label: "Action needed", variant: "destructive" as const })
    : imapIntegrations.length > 0
      ? ({ label: "Connected", variant: "success" as const })
      : undefined;

  const dropboxStatus = dropboxLoading
    ? "Loading..."
    : dropboxIntegrations.length === 0
      ? tFolder("subtitle", { provider: tFolder("providerNames.dropbox") })
      : dropboxIntegrations.length === 1
        ? dropboxIntegrations[0].accountEmail
        : `${dropboxIntegrations.length} accounts`;

  const dropboxBadge = dropboxIntegrations.some((i) => i.needsReauth || i.pausedReason)
    ? ({ label: "Action needed", variant: "destructive" as const })
    : dropboxIntegrations.length > 0
      ? ({ label: "Connected", variant: "success" as const })
      : undefined;

  const gdriveStatus = gdriveLoading
    ? "Loading..."
    : gdriveIntegrations.length === 0
      ? tFolder("subtitle", { provider: tFolder("providerNames.gdrive") })
      : gdriveIntegrations.length === 1
        ? gdriveIntegrations[0].accountEmail
        : `${gdriveIntegrations.length} accounts`;

  const gdriveBadge = gdriveIntegrations.some((i) => i.needsReauth || i.pausedReason)
    ? ({ label: "Action needed", variant: "destructive" as const })
    : gdriveIntegrations.length > 0
      ? ({ label: "Connected", variant: "success" as const })
      : undefined;

  const emailForwardingStatus = primaryAddress
    ? primaryAddress.isActive
      ? `${primaryAddress.emailsReceived} emails received`
      : "Paused"
    : "Setting up...";

  const emailForwardingBadge = primaryAddress
    ? primaryAddress.isActive
      ? ({ label: "Active", variant: "success" as const })
      : ({ label: "Paused", variant: "warning" as const })
    : undefined;

  const finanzonline = userData?.finanzonline;
  const finanzonlineStatus = finanzonline?.isConfigured
    ? finanzonline.connectionStatus === "valid"
      ? `Teilnehmer: ${finanzonline.teilnehmerId}`
      : finanzonline.connectionStatus === "invalid"
        ? "Connection invalid"
        : "Credentials saved, untested"
    : "Not configured";

  const finanzonlineBadge = finanzonline?.isConfigured
    ? finanzonline.connectionStatus === "valid"
      ? ({ label: "Connected", variant: "success" as const })
      : finanzonline.connectionStatus === "invalid"
        ? ({ label: "Invalid", variant: "destructive" as const })
        : ({ label: "Untested", variant: "warning" as const })
    : undefined;

  // --- Attention banner ---
  const attentionItems = useMemo(() => {
    const items: AttentionItem[] = [];

    // Gmail accounts needing reauth or with failed syncs
    for (const i of gmailIntegrations) {
      if (i.needsReauth) {
        items.push({
          message: `Gmail (${i.email}) needs to be reconnected`,
          href: `/integrations/${i.id}`,
        });
      } else if (i.lastSyncStatus === "failed") {
        items.push({
          message: `Gmail (${i.email}) sync failed`,
          href: `/integrations/${i.id}`,
        });
      }
    }

    // IMAP mailboxes needing repair or with failed syncs. Same conditions as
    // the Gmail loop above: the badge on the IMAP card already reacted to
    // these, but nothing linked the individual mailbox that caused it.
    for (const i of imapIntegrations) {
      if (i.needsReauth) {
        items.push({
          message: `IMAP mailbox (${i.email}) needs to be reconnected`,
          href: `/integrations/${i.id}`,
        });
      } else if (i.lastSyncStatus === "failed") {
        items.push({
          message: `IMAP mailbox (${i.email}) sync failed`,
          href: `/integrations/${i.id}`,
        });
      }
    }

    // Email forwarding paused
    if (primaryAddress && !primaryAddress.isActive) {
      items.push({
        message: "Email forwarding is paused",
        href: "/integrations/email-inbound",
      });
    }

    // FinanzOnline invalid (admin only)
    if (isAdmin && finanzonline?.isConfigured && finanzonline.connectionStatus === "invalid") {
      items.push({
        message: "FinanzOnline connection is invalid",
        href: "/integrations/finanzonline",
      });
    }

    return items;
  }, [gmailIntegrations, imapIntegrations, primaryAddress, isAdmin, finanzonline]);

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <SettingsPageHeader
          title="Integrations"
          description="Connect external services to automatically find and match invoices"
        />

        {/* Attention banner */}
        {attentionItems.length > 0 && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              <ul className="space-y-1">
                {attentionItems.map((item) => (
                  <li key={item.href}>
                    <Link href={item.href} className="underline hover:no-underline">
                      {item.message}
                    </Link>
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        <section>
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
            {tSections("email")}
          </h3>
          <div className="space-y-2">
            <IntegrationCard
              icon={<GmailLogo className="h-4 w-4 text-[#EA4335] dark:text-red-400" />}
              iconBg="bg-red-100 dark:bg-red-900/40"
              name="Gmail"
              status={gmailStatus}
              badge={gmailBadge}
              href="/integrations/gmail"
            />
            <IntegrationCard
              icon={<Mail className="h-4 w-4 text-teal-600 dark:text-teal-400" />}
              iconBg="bg-teal-100 dark:bg-teal-900/40"
              name="IMAP Mailbox"
              status={imapStatus}
              badge={imapBadge}
              href="/integrations/imap"
            />
            <IntegrationCard
              icon={<Inbox className="h-4 w-4 text-purple-600 dark:text-purple-400" />}
              iconBg="bg-purple-100 dark:bg-purple-900/40"
              name="Email Forwarding"
              status={emailForwardingStatus}
              badge={emailForwardingBadge}
              href="/integrations/email-inbound"
            />
            <IntegrationCard
              icon={<OutlookLogo className="h-4 w-4 text-[#0078D4] dark:text-blue-400" />}
              iconBg="bg-blue-100 dark:bg-blue-900/40"
              name="Microsoft Outlook"
              status="Connect your Outlook account"
              badge={{ label: "Coming Soon", variant: "muted" }}
              href="#"
              comingSoon
            />
          </div>
        </section>

        <section>
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
            {tSections("files")}
          </h3>
          <div className="space-y-2">
            <IntegrationCard
              icon={<DropboxLogo className="h-4 w-4 text-[#0061FF] dark:text-blue-400" />}
              iconBg="bg-blue-100 dark:bg-blue-900/40"
              name={tFolder("providerNames.dropbox")}
              status={dropboxStatus}
              badge={dropboxBadge}
              href="/integrations/dropbox"
            />
            <IntegrationCard
              icon={<GoogleDriveLogo className="h-4 w-4 text-[#1FA463] dark:text-emerald-400" />}
              iconBg="bg-emerald-100 dark:bg-emerald-900/40"
              name={tFolder("providerNames.gdrive")}
              status={gdriveStatus}
              badge={gdriveBadge}
              href="/integrations/gdrive"
            />
          </div>
        </section>

        <section>
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
            {tSections("browser")}
          </h3>
          <div className="space-y-2">
            <IntegrationCard
              icon={<Globe className="h-4 w-4 text-emerald-700 dark:text-emerald-400" />}
              iconBg="bg-emerald-100 dark:bg-emerald-900/40"
              name="Browser Plugin"
              status={extensionStatus}
              badge={extensionBadge}
              href="/integrations/browser"
            />
          </div>
        </section>

        {/* Export & Tax */}
        <section>
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
            Export & Tax
          </h3>
          <div className="space-y-2">
            <IntegrationCard
              icon={<BmdLogo className="h-4 w-4 text-[#FF701A] dark:text-orange-400" />}
              iconBg="bg-orange-100 dark:bg-orange-900/40"
              name="BMD NTCS Export"
              status="Export transactions for BMD"
              href="/integrations/bmd-export"
            />
            {isAdmin && (
              <IntegrationCard
                icon={<FinanzOnlineLogo className="h-4 w-4 text-[#E6320F] dark:text-red-400" />}
                iconBg="bg-red-100 dark:bg-red-900/40"
                name="FinanzOnline"
                status={finanzonlineStatus}
                badge={finanzonlineBadge}
                href="/integrations/finanzonline"
              />
            )}
          </div>
        </section>

        {/* Developer */}
        <section data-onboarding="developer-section">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
            Developer
          </h3>
          <div className="space-y-2">
            <ApiKeysInline />

            <IntegrationCard
              icon={<OpenClawLogo className="h-4 w-4 text-[#E5372F] dark:text-red-400" />}
              iconBg="bg-red-100 dark:bg-red-900/40"
              name="OpenClaw Skill"
              status="Install from ClawHub or npm"
              href="/integrations/openclaw"
            />
            <IntegrationCard
              icon={<ClaudeLogo className="h-4 w-4 text-[#D97757] dark:text-orange-400" />}
              iconBg="bg-orange-100 dark:bg-orange-900/40"
              name="Claude Desktop (MCP)"
              status="Model Context Protocol server"
              href="/integrations/claude-mcp"
            />
            <IntegrationCard
              icon={<OpenAILogo className="h-4 w-4 text-foreground" />}
              iconBg="bg-gray-100 dark:bg-gray-800/60"
              name="ChatGPT Custom GPT"
              status="Import OpenAPI spec in GPT builder"
              href="/integrations/chatgpt"
            />
            <IntegrationCard
              icon={<Code className="h-4 w-4 text-gray-600 dark:text-gray-400" />}
              iconBg="bg-gray-100 dark:bg-gray-800/60"
              name="REST API"
              status="Direct HTTP access for custom integrations"
              href="/integrations/rest-api"
            />
          </div>

          {/* Resources */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-3">
            <ResourceLink
              icon={<BookOpen className="h-4 w-4" />}
              label="llm.txt"
              description="Machine-readable API overview"
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
        </section>
      </div>
    </div>
  );
}

function IntegrationsFallback() {
  return (
    <div className="h-full flex items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
}

export default function SettingsIntegrationsPage() {
  return (
    <SmartFeatureGuard feature="aiMatching">
      <Suspense fallback={<IntegrationsFallback />}>
        <IntegrationsContent />
      </Suspense>
    </SmartFeatureGuard>
  );
}
