"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { CountryGrid } from "@/components/expand/country-grid";
import { BackCountryDialog } from "@/components/expand/back-country-dialog";
import { LandingFooter } from "@/components/landing/footer";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2 } from "lucide-react";

export function ExpandPageContent() {
  const searchParams = useSearchParams();
  const highlightCountry = searchParams.get("country") ?? undefined;
  const successCountry = searchParams.get("success");

  const [backingCountry, setBackingCountry] = useState<string | null>(null);

  return (
    <>
      <main className="flex-1 flex flex-col items-center px-4 py-12">
        {/* Header / Nav */}
        <div className="w-full max-w-5xl mb-8">
          <Link
            href="/"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            &larr; Back to FiBuKI
          </Link>
        </div>

        {/* Success Banner */}
        {successCountry && (
          <div className="w-full max-w-5xl mb-8 rounded-lg border border-green-300 bg-green-50 dark:bg-green-900/20 dark:border-green-700 p-4 flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 shrink-0" />
            <p className="text-sm text-green-900 dark:text-green-200">
              Thank you for backing! You&apos;ll receive a confirmation email
              shortly. We&apos;ll notify you as soon as your country goes live.
            </p>
          </div>
        )}

        {/* Hero */}
        <div className="text-center space-y-4 max-w-2xl mb-12">
          <h1 className="text-4xl font-bold tracking-tight">
            Help FiBuKI get PSD2 banking in more countries
          </h1>
          <p className="text-lg text-muted-foreground">
            FiBuKI connects directly to your bank via PSD2 — no CSV uploads
            needed. Right now this works in Austria. Expanding to each new
            country requires a separate banking licence. Back your country with
            €10 to help us get there — it covers your entire first month.
          </p>
          <div className="flex items-center justify-center gap-2 pt-2">
            <Badge variant="success">Austria — Live</Badge>
          </div>
        </div>

        {/* Country Grid */}
        <div className="w-full max-w-5xl mb-16">
          <CountryGrid
            onBack={setBackingCountry}
            highlightCountry={highlightCountry}
          />
        </div>

        {/* FAQ */}
        <div className="w-full max-w-2xl space-y-8 mb-16">
          <h2 className="text-2xl font-semibold text-center">
            Frequently Asked Questions
          </h2>

          <div className="space-y-6">
            <FaqItem
              question="Why does each country need separate funding?"
              answer="PSD2 banking access is licenced per country. Each new country requires a dedicated banking connection licence with ongoing costs. Crowdfunding lets us activate countries where there's real demand."
            />
            <FaqItem
              question="What happens to my €10?"
              answer="Your €10 reserves your spot. Once enough backers join and we activate the country's PSD2 banking connection, your €10 covers your first month's subscription — so your first month is essentially free."
            />
            <FaqItem
              question="When does my subscription start?"
              answer="Only after the country goes live. You won't be charged any recurring fees until PSD2 banking is active in your country."
            />
            <FaqItem
              question="What if the target isn't reached?"
              answer="If a country doesn't reach its backer target within a reasonable timeframe, we'll issue a full refund of your €10."
            />
            <FaqItem
              question="Do I need a FiBuKI account?"
              answer="No! You can back a country with just your email address. We'll notify you when banking goes live so you can sign up."
            />
          </div>
        </div>
      </main>

      <LandingFooter />

      {/* Back Country Dialog */}
      <BackCountryDialog
        countryCode={backingCountry}
        onClose={() => setBackingCountry(null)}
      />
    </>
  );
}

function FaqItem({
  question,
  answer,
}: {
  question: string;
  answer: string;
}) {
  return (
    <div className="space-y-2">
      <h3 className="font-medium">{question}</h3>
      <p className="text-sm text-muted-foreground">{answer}</p>
    </div>
  );
}
