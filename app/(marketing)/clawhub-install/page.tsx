import { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Banknote, Brain, Zap, Terminal, Globe, ExternalLink, BookOpen, FileText } from "lucide-react";
import { FibukiMascot } from "@/components/ui/fibuki-mascot";
import { IntegrationMethodTabs } from "@/components/marketing/integration-tabs";

export const metadata: Metadata = {
  title: "Connect Your AI Agent to FiBuKI",
  description:
    "Access European bank transactions via PSD2 Open Banking in your AI agent. Browse transactions, match receipts, categorize expenses.",
};

export default function ClawHubInstallPage() {
  return (
    <main className="flex-1 py-12 px-4">
      <div className="max-w-3xl mx-auto">
        {/* Back link */}
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-8"
        >
          <ArrowLeft className="h-4 w-4" />
          fibuki.com
        </Link>

        {/* Hero */}
        <div className="flex items-center gap-4 mb-6">
          <FibukiMascot size={56} />
          <div>
            <h1 className="text-3xl font-bold">
              Connect Your AI Agent to FiBuKI
            </h1>
            <p className="text-muted-foreground mt-1">
              PSD2 Open Banking for European bank accounts, powered by AI receipt matching
            </p>
          </div>
        </div>

        <p className="text-muted-foreground mb-8">
          FiBuKI connects to European banks via PSD2 and gives your AI agent access to
          transactions, receipt matching, expense categorization, and partner management.
          Works with OpenClaw, Claude Desktop, ChatGPT, or any HTTP client.
          Free plan includes 50 transactions/month.
        </p>

        {/* Setup steps */}
        <h2 className="text-xl font-semibold mb-4">Setup</h2>
        <div className="space-y-4 mb-8">
          <div className="flex gap-4 items-start">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-medium">
              1
            </span>
            <div>
              <p className="font-medium">Create your account</p>
              <Link
                href="/register"
                className="text-sm text-primary hover:underline inline-flex items-center gap-1"
              >
                Sign up at fibuki.com/register
                <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
          </div>

          <div className="flex gap-4 items-start">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-medium">
              2
            </span>
            <div>
              <p className="font-medium">Get your API key</p>
              <div className="space-y-2 mt-1">
                <div className="rounded-md bg-muted px-3 py-2 text-sm">
                  <div className="flex items-center gap-2 font-mono">
                    <Terminal className="h-4 w-4 text-muted-foreground shrink-0" />
                    npx @fibukiapp/cli auth
                  </div>
                  <p className="text-muted-foreground mt-1 ml-6">
                    Opens your browser, creates the key, and saves it automatically.
                  </p>
                </div>
                <div className="rounded-md bg-muted px-3 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span>Or get your key manually</span>
                  </div>
                  <p className="text-muted-foreground mt-1 ml-6">
                    Settings &rarr; Integrations &rarr; API Keys &rarr; Create API Key
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="flex gap-4 items-start">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-medium">
              3
            </span>
            <div className="w-full">
              <p className="font-medium mb-3">Connect your AI agent</p>
              <IntegrationMethodTabs />
            </div>
          </div>
        </div>

        {/* Resources */}
        <h2 className="text-xl font-semibold mb-4">Resources</h2>
        <div className="grid sm:grid-cols-3 gap-3 mb-8">
          <a
            href="https://fibuki.com/llm.txt"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-start gap-2.5 rounded-lg border p-3 hover:bg-muted/50 transition-colors"
          >
            <BookOpen className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-medium flex items-center gap-1">
                llm.txt
                <ExternalLink className="h-3 w-3 text-muted-foreground" />
              </div>
              <div className="text-xs text-muted-foreground">
                Machine-readable API overview for AI agents
              </div>
            </div>
          </a>
          <a
            href="https://fibuki.com/api/openapi.json"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-start gap-2.5 rounded-lg border p-3 hover:bg-muted/50 transition-colors"
          >
            <FileText className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-medium flex items-center gap-1">
                OpenAPI Spec
                <ExternalLink className="h-3 w-3 text-muted-foreground" />
              </div>
              <div className="text-xs text-muted-foreground">
                Full tool schema for GPT Actions
              </div>
            </div>
          </a>
          <a
            href="https://www.npmjs.com/package/@fibukiapp/cli"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-start gap-2.5 rounded-lg border p-3 hover:bg-muted/50 transition-colors"
          >
            <Terminal className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-medium flex items-center gap-1">
                CLI on npm
                <ExternalLink className="h-3 w-3 text-muted-foreground" />
              </div>
              <div className="text-xs text-muted-foreground">
                @fibukiapp/cli package
              </div>
            </div>
          </a>
        </div>

        {/* What you get */}
        <h2 className="text-xl font-semibold mb-4">What Your Agent Can Do</h2>
        <div className="grid sm:grid-cols-3 gap-4 mb-8">
          <div className="rounded-lg border p-4">
            <Banknote className="h-5 w-5 text-primary mb-2" />
            <p className="font-medium text-sm">Bank Transactions</p>
            <p className="text-sm text-muted-foreground">
              Browse accounts, search transactions, import data, track completion
            </p>
          </div>
          <div className="rounded-lg border p-4">
            <Brain className="h-5 w-5 text-primary mb-2" />
            <p className="font-medium text-sm">AI Matching</p>
            <p className="text-sm text-muted-foreground">
              Upload receipts, auto-match to transactions, score confidence
            </p>
          </div>
          <div className="rounded-lg border p-4">
            <Zap className="h-5 w-5 text-primary mb-2" />
            <p className="font-medium text-sm">Categorization</p>
            <p className="text-sm text-muted-foreground">
              Manage partners, assign categories, drive bookkeeping to 100%
            </p>
          </div>
        </div>

        {/* CTA */}
        <div className="rounded-lg bg-muted/50 p-6 text-center">
          <Link
            href="/register"
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Create Free Account
          </Link>
          <p className="text-sm text-muted-foreground mt-3">
            Already have an account?{" "}
            <Link href="/settings/integrations" className="text-primary hover:underline">
              Go to Settings &rarr; Integrations
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
