import type { Metadata } from "next";
import Link from "next/link";

interface Props {
  params: Promise<{ code: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code } = await params;

  const title = "Join FiBuKI — get €20 off your first year";
  const description =
    "FiBuKI automatically matches your bank transactions with receipts using AI. Sign up with this referral link and save €20 on your first yearly plan.";

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: `https://fibuki.com/r/${code}`,
      siteName: "FiBuKI",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

export default async function ReferralLandingPage({ params }: Props) {
  const { code } = await params;

  return (
    <div className="min-h-[80vh] flex items-center justify-center px-4">
      <div className="max-w-lg w-full text-center space-y-8">
        <div className="space-y-4">
          <div className="inline-flex items-center gap-2 rounded-full bg-green-100 dark:bg-green-900/30 px-4 py-1.5 text-sm font-medium text-green-800 dark:text-green-300">
            Referral Invite
          </div>

          <h1 className="text-4xl font-bold tracking-tight">
            Get <span className="text-green-600 dark:text-green-400">€20 off</span> your first year
          </h1>

          <p className="text-lg text-muted-foreground leading-relaxed">
            FiBuKI automatically matches your bank transactions with receipts
            using AI. Import your bank data, upload or email your receipts, and
            let FiBuKI handle the rest.
          </p>
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
            <div className="rounded-lg border bg-card p-4 space-y-1">
              <div className="font-semibold">Bank Import</div>
              <div className="text-muted-foreground">CSV or direct PSD2 connection</div>
            </div>
            <div className="rounded-lg border bg-card p-4 space-y-1">
              <div className="font-semibold">AI Matching</div>
              <div className="text-muted-foreground">Receipts matched automatically</div>
            </div>
            <div className="rounded-lg border bg-card p-4 space-y-1">
              <div className="font-semibold">Tax Ready</div>
              <div className="text-muted-foreground">Export to your accountant</div>
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <Link
            href={`/register?ref=${code}`}
            className="inline-flex items-center justify-center rounded-md bg-primary px-8 py-3 text-base font-medium text-primary-foreground shadow hover:bg-primary/90 transition-colors"
          >
            Sign up and save €20
          </Link>
          <p className="text-xs text-muted-foreground">
            Discount applies to yearly plans. No credit card required to sign up.
          </p>
        </div>
      </div>
    </div>
  );
}
