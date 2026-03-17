/**
 * Admin-only: Seed countryExpansion documents for all target countries.
 * Idempotent — skips existing docs.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import { FieldValue } from "firebase-admin/firestore";

const COUNTRIES = [
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
  { code: "IT", name: "Italy" },
  { code: "ES", name: "Spain" },
  { code: "NL", name: "Netherlands" },
  { code: "BE", name: "Belgium" },
  { code: "PT", name: "Portugal" },
  { code: "IE", name: "Ireland" },
  { code: "FI", name: "Finland" },
  { code: "LU", name: "Luxembourg" },
  { code: "GR", name: "Greece" },
  { code: "SK", name: "Slovakia" },
  { code: "SI", name: "Slovenia" },
];

const DEFAULT_TARGET_BACKERS = 30;
const MONTHLY_COST_CENTS = 20000; // €200

interface SeedResponse {
  created: number;
  skipped: number;
}

export const seedCountryExpansionCallable = createCallable<
  Record<string, never>,
  SeedResponse
>(
  { name: "seedCountryExpansion" },
  async (ctx) => {
    // Admin check
    const isAdmin = ctx.request.auth?.token?.admin === true;
    const isSuperAdmin = ctx.request.auth?.token?.email === "felix@i7v6.com";
    if (!isAdmin && !isSuperAdmin) {
      throw new HttpsError("permission-denied", "Admin access required");
    }

    let created = 0;
    let skipped = 0;

    for (const country of COUNTRIES) {
      const ref = ctx.db.collection("countryExpansion").doc(country.code);
      const existing = await ref.get();

      if (existing.exists) {
        skipped++;
        continue;
      }

      await ref.set({
        countryCode: country.code,
        countryName: country.name,
        status: "funding",
        targetBackers: DEFAULT_TARGET_BACKERS,
        currentBackers: 0,
        totalCommitted: 0,
        monthlyCost: MONTHLY_COST_CENTS,
        createdAt: FieldValue.serverTimestamp(),
      });

      created++;
    }

    console.log(
      `[seedCountryExpansion] Created ${created}, skipped ${skipped}`
    );

    return { created, skipped };
  }
);
