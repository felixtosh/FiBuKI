import { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Banknote, Brain, Zap, Terminal, ExternalLink } from "lucide-react";
import { FibukiMascot } from "@/components/ui/fibuki-mascot";

export const metadata: Metadata = {
  title: "Connect Your Bank Transactions to OpenClaw - FiBuKI",
  description:
    "Access European bank transactions via PSD2 Open Banking in your AI agent. Browse transactions, match receipts, categorize expenses.",
};

function PlanCard({
  name,
  price,
  features,
  highlight,
}: {
  name: string;
  price: string;
  features: string[];
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-6 flex flex-col ${
        highlight ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border"
      }`}
    >
      <h3 className="text-lg font-semibold">{name}</h3>
      <p className="text-2xl font-bold mt-1">{price}</p>
      <ul className="mt-4 space-y-2 flex-1">
        {features.map((f) => (
          <li key={f} className="text-sm text-muted-foreground flex gap-2">
            <span className="text-primary shrink-0">-</span>
            {f}
          </li>
        ))}
      </ul>
    </div>
  );
}

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
              Connect Your Bank Transactions to OpenClaw
            </h1>
            <p className="text-muted-foreground mt-1">
              PSD2 Open Banking for European bank accounts, powered by AI receipt matching
            </p>
          </div>
        </div>

        <p className="text-muted-foreground mb-8">
          FiBuKI connects to European banks via PSD2 and gives your AI agent access to
          transactions, receipt matching, expense categorization, and partner management.
          Built for small businesses and freelancers in Austria and Germany.
        </p>

        {/* Plans */}
        <h2 className="text-xl font-semibold mb-4">Choose Your Plan</h2>
        <div className="grid sm:grid-cols-3 gap-4 mb-8">
          <PlanCard
            name="Free"
            price="0 EUR/mo"
            features={[
              "50 transactions/month",
              "Browse & categorize",
              "API & MCP access",
              "10 req/min rate limit",
            ]}
          />
          <PlanCard
            name="Data"
            price="9.99 EUR/mo"
            highlight
            features={[
              "200 transactions/month",
              "Full API access",
              "CSV/JSON export",
              "60 req/min rate limit",
            ]}
          />
          <PlanCard
            name="Smart"
            price="19 EUR/mo"
            features={[
              "500 transactions/month",
              "AI receipt matching",
              "File upload via API",
              "Gmail integration",
              "120 req/min rate limit",
            ]}
          />
        </div>

        <p className="text-sm text-muted-foreground mb-8">
          PSD2 Open Banking accreditation is expensive. Paid plans help us cover
          compliance costs and keep the free tier available.
        </p>

        {/* Setup steps */}
        <h2 className="text-xl font-semibold mb-4">Quick Setup</h2>
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
              <div className="mt-1 rounded-md bg-muted px-3 py-2 font-mono text-sm flex items-center gap-2">
                <Terminal className="h-4 w-4 text-muted-foreground shrink-0" />
                npx @fibukiapp/cli auth
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Or manually: Settings &rarr; Integrations &rarr; AI Agents
              </p>
            </div>
          </div>

          <div className="flex gap-4 items-start">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-medium">
              3
            </span>
            <div>
              <p className="font-medium">Set the environment variable</p>
              <div className="mt-1 rounded-md bg-muted px-3 py-2 font-mono text-sm">
                export FIBUKI_API_KEY=&quot;fk_your_key_here&quot;
              </div>
            </div>
          </div>

          <div className="flex gap-4 items-start">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-medium">
              4
            </span>
            <div>
              <p className="font-medium">Restart OpenClaw</p>
              <p className="text-sm text-muted-foreground">
                Tools load dynamically from the API based on your plan.
              </p>
            </div>
          </div>
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
              Go to Settings
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
