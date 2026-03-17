"use client";

import { useEffect, useState } from "react";
import {
  collection,
  onSnapshot,
  query,
  orderBy,
} from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { CountryCard } from "./country-card";
import { EXPANDABLE_COUNTRIES } from "@/types/expand";
import type { CountryExpansion } from "@/types/expand";

interface CountryGridProps {
  onBack: (countryCode: string) => void;
  highlightCountry?: string;
}

export function CountryGrid({ onBack, highlightCountry }: CountryGridProps) {
  const [countries, setCountries] = useState<CountryExpansion[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(
      collection(db, "countryExpansion"),
      orderBy("currentBackers", "desc")
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map((doc) => ({
        ...doc.data(),
        countryCode: doc.id,
      })) as CountryExpansion[];
      setCountries(data);
      setLoading(false);
    });

    return unsubscribe;
  }, []);

  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="rounded-lg border bg-card p-6 h-48 animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (countries.length === 0) {
    return (
      <p className="text-center text-muted-foreground py-12">
        No countries available for expansion yet. Check back soon!
      </p>
    );
  }

  // Sort: highlighted first, then funding, then active, then coming_soon
  const sorted = [...countries].sort((a, b) => {
    if (highlightCountry) {
      if (a.countryCode === highlightCountry) return -1;
      if (b.countryCode === highlightCountry) return 1;
    }
    const statusOrder = { funding: 0, active: 1, coming_soon: 2 };
    const statusDiff = statusOrder[a.status] - statusOrder[b.status];
    if (statusDiff !== 0) return statusDiff;
    return b.currentBackers - a.currentBackers;
  });

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
      {sorted.map((country) => {
        const meta = EXPANDABLE_COUNTRIES.find(
          (c) => c.code === country.countryCode
        );
        return (
          <CountryCard
            key={country.countryCode}
            country={country}
            flag={meta?.flag ?? "🏳️"}
            onBack={onBack}
          />
        );
      })}
    </div>
  );
}
