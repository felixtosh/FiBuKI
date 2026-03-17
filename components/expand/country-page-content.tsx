"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { LandingFooter } from "@/components/landing/footer";
import { BackCountryDialog } from "@/components/expand/back-country-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { CheckCircle2 } from "lucide-react";
import { EXPANDABLE_COUNTRIES } from "@/types/expand";
import type { CountryExpansion } from "@/types/expand";

interface CountryPageContentProps {
  countryCode: string;
}

export function CountryPageContent({ countryCode }: CountryPageContentProps) {
  const searchParams = useSearchParams();
  const isSuccess = searchParams.get("success") === "1";
  const meta = EXPANDABLE_COUNTRIES.find((c) => c.code === countryCode);

  const [country, setCountry] = useState<CountryExpansion | null>(null);
  const [loading, setLoading] = useState(true);
  const [showDialog, setShowDialog] = useState(false);

  useEffect(() => {
    const unsubscribe = onSnapshot(
      doc(db, "countryExpansion", countryCode),
      (snap) => {
        if (snap.exists()) {
          setCountry({ ...snap.data(), countryCode: snap.id } as CountryExpansion);
        }
        setLoading(false);
      }
    );
    return unsubscribe;
  }, [countryCode]);

  const progress = country
    ? Math.min((country.currentBackers / country.targetBackers) * 100, 100)
    : 0;
  const remaining = country
    ? Math.max(country.targetBackers - country.currentBackers, 0)
    : 0;

  return (
    <>
      <main className="flex-1 flex flex-col items-center px-4 py-12">
        {/* Nav */}
        <div className="w-full max-w-2xl mb-8 flex items-center justify-between">
          <Link
            href="/expand"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            &larr; All countries
          </Link>
          <Link
            href="/"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            FiBuKI Home
          </Link>
        </div>

        {/* Success Banner */}
        {isSuccess && (
          <div className="w-full max-w-2xl mb-8 rounded-lg border border-green-300 bg-green-50 dark:bg-green-900/20 dark:border-green-700 p-4 flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 shrink-0" />
            <p className="text-sm text-green-900 dark:text-green-200">
              Thank you for backing {meta?.name}! You&apos;ll receive a
              confirmation email shortly. We&apos;ll notify you as soon as PSD2
              banking goes live.
            </p>
          </div>
        )}

        {/* Hero */}
        <div className="text-center space-y-4 max-w-2xl mb-10">
          <span className="text-6xl">{meta?.flag}</span>
          <h1 className="text-4xl font-bold tracking-tight">
            Help unlock PSD2 banking in {meta?.name}
          </h1>
          <p className="text-lg text-muted-foreground">
            FiBuKI connects directly to your bank — no CSV uploads needed. Help
            us activate PSD2 bank connections in {meta?.name} by backing with
            €10. It covers your entire first month.
          </p>
        </div>

        {/* Progress Card */}
        {loading ? (
          <div className="w-full max-w-md rounded-lg border bg-card p-8 animate-pulse h-48" />
        ) : country ? (
          <div className="w-full max-w-md rounded-lg border bg-card p-8 space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-lg">{meta?.name}</h2>
              <StatusBadge status={country.status} />
            </div>

            <div className="space-y-2">
              <Progress value={progress} className="h-4" />
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  <span className="font-semibold text-foreground">
                    {country.currentBackers}
                  </span>{" "}
                  / {country.targetBackers} backers
                </span>
                {remaining > 0 && country.status === "funding" && (
                  <span className="text-muted-foreground">
                    {remaining} more needed
                  </span>
                )}
              </div>
            </div>

            {country.status === "funding" && (
              <Button
                size="lg"
                className="w-full"
                onClick={() => setShowDialog(true)}
              >
                Back {meta?.name} — €10
              </Button>
            )}

            {country.status === "active" && (
              <Button asChild size="lg" variant="outline" className="w-full">
                <a href="/login">Sign Up — Banking is Live!</a>
              </Button>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground">
            Country information not available.
          </p>
        )}

        {/* How it works */}
        <div className="w-full max-w-2xl mt-16 space-y-8">
          <h2 className="text-2xl font-semibold text-center">How it works</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 text-center">
            <div className="space-y-2">
              <div className="text-2xl font-bold text-primary">1</div>
              <h3 className="font-medium">Back with €10</h3>
              <p className="text-sm text-muted-foreground">
                One-time payment to show demand for {meta?.name}
              </p>
            </div>
            <div className="space-y-2">
              <div className="text-2xl font-bold text-primary">2</div>
              <h3 className="font-medium">We activate PSD2</h3>
              <p className="text-sm text-muted-foreground">
                Once enough backers join, we enable bank connections
              </p>
            </div>
            <div className="space-y-2">
              <div className="text-2xl font-bold text-primary">3</div>
              <h3 className="font-medium">First month free</h3>
              <p className="text-sm text-muted-foreground">
                Your €10 covers the first month of your subscription
              </p>
            </div>
          </div>
        </div>
      </main>

      <LandingFooter />

      <BackCountryDialog
        countryCode={showDialog ? countryCode : null}
        onClose={() => setShowDialog(false)}
      />
    </>
  );
}

function StatusBadge({ status }: { status: CountryExpansion["status"] }) {
  switch (status) {
    case "funding":
      return <Badge variant="info">Funding</Badge>;
    case "active":
      return <Badge variant="success">Live</Badge>;
    case "coming_soon":
      return <Badge variant="muted">Coming Soon</Badge>;
  }
}
