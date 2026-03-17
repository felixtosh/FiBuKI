"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { CountryExpansion } from "@/types/expand";

interface CountryCardProps {
  country: CountryExpansion;
  flag: string;
  onBack: (countryCode: string) => void;
}

export function CountryCard({ country, flag, onBack }: CountryCardProps) {
  const progress = Math.min(
    (country.currentBackers / country.targetBackers) * 100,
    100
  );

  return (
    <div className="rounded-lg border bg-card p-6 flex flex-col gap-4">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <span className="text-3xl">{flag}</span>
          <h3 className="font-semibold text-lg">{country.countryName}</h3>
        </div>
        <StatusBadge status={country.status} />
      </div>

      <div className="space-y-2">
        <Progress value={progress} className="h-3" />
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            {country.currentBackers}
          </span>{" "}
          / {country.targetBackers} backers
        </p>
      </div>

      {country.status === "funding" && (
        <Button
          onClick={() => onBack(country.countryCode)}
          className="w-full mt-auto"
        >
          Back this country — €10
        </Button>
      )}

      {country.status === "active" && (
        <Button asChild variant="outline" className="w-full mt-auto">
          <a href="/login">Sign Up</a>
        </Button>
      )}

      {country.status === "coming_soon" && (
        <Button disabled variant="secondary" className="w-full mt-auto">
          Coming Soon
        </Button>
      )}
    </div>
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
