"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Copy, Check, BookOpen, FileText, Terminal, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePageTitle } from "@/hooks/use-page-title";

// --- IntegrationSubPageLayout ---

export function IntegrationSubPageLayout({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  usePageTitle(title);

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.push("/settings/integrations")}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-xl font-semibold">{title}</h1>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
        </div>

        {children}

        <DeveloperResources />
      </div>
    </div>
  );
}

// --- ConfigBlock ---

export function ConfigBlock({
  label,
  code,
  language = "json",
}: {
  label: string;
  code: string;
  language?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{label}</span>
        <Button variant="ghost" size="sm" onClick={handleCopy} className="h-7 text-xs gap-1">
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="text-xs bg-muted/50 border rounded-lg px-4 py-3 overflow-x-auto whitespace-pre-wrap font-mono">
        {code}
      </pre>
    </div>
  );
}

// --- DeveloperResources ---

export function DeveloperResources() {
  return (
    <div className="pt-4 border-t space-y-3">
      <div className="text-sm font-medium">Resources</div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <ResourceLinkSmall
          icon={<BookOpen className="h-4 w-4" />}
          label="llm.txt"
          description="Machine-readable API overview"
          href="https://fibuki.com/llm.txt"
        />
        <ResourceLinkSmall
          icon={<FileText className="h-4 w-4" />}
          label="OpenAPI Spec"
          description="Full tool schema for GPT Actions"
          href="https://fibuki.com/api/openapi.json"
        />
        <ResourceLinkSmall
          icon={<Terminal className="h-4 w-4" />}
          label="CLI on npm"
          description="@fibukiapp/cli package"
          href="https://www.npmjs.com/package/@fibukiapp/cli"
        />
      </div>
    </div>
  );
}

function ResourceLinkSmall({
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

// --- Step component for setup instructions ---

export function SetupStep({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-4 items-start">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-medium">
        {number}
      </span>
      <div className="space-y-2">
        <p className="font-medium">{title}</p>
        {children}
      </div>
    </div>
  );
}
