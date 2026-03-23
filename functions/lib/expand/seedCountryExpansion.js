"use strict";
/**
 * Admin-only: Seed countryExpansion documents for all target countries.
 * Idempotent — skips existing docs.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.seedCountryExpansionCallable = void 0;
const createCallable_1 = require("../utils/createCallable");
const firestore_1 = require("firebase-admin/firestore");
const COUNTRIES = [
    { code: "AT", name: "Austria", seedBackers: 3 },
    { code: "DE", name: "Germany", seedBackers: 2 },
    { code: "FR", name: "France", seedBackers: 1 },
    { code: "IT", name: "Italy", seedBackers: 1 },
    { code: "ES", name: "Spain", seedBackers: 2 },
    { code: "NL", name: "Netherlands", seedBackers: 1 },
    { code: "BE", name: "Belgium", seedBackers: 0 },
    { code: "PT", name: "Portugal", seedBackers: 1 },
    { code: "IE", name: "Ireland", seedBackers: 0 },
    { code: "FI", name: "Finland", seedBackers: 0 },
    { code: "LU", name: "Luxembourg", seedBackers: 0 },
    { code: "GR", name: "Greece", seedBackers: 1 },
    { code: "SK", name: "Slovakia", seedBackers: 0 },
    { code: "SI", name: "Slovenia", seedBackers: 0 },
];
const DEFAULT_TARGET_BACKERS = 30;
const MONTHLY_COST_CENTS = 2000; // €20 (finAPI International add-on per country)
exports.seedCountryExpansionCallable = (0, createCallable_1.createCallable)({ name: "seedCountryExpansion" }, async (ctx) => {
    // Admin check
    const isAdmin = ctx.request.auth?.token?.admin === true;
    const isSuperAdmin = ctx.request.auth?.token?.email === "felix@i7v6.com";
    if (!isAdmin && !isSuperAdmin) {
        throw new createCallable_1.HttpsError("permission-denied", "Admin access required");
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
            currentBackers: country.seedBackers,
            totalCommitted: country.seedBackers * 1000,
            monthlyCost: MONTHLY_COST_CENTS,
            createdAt: firestore_1.FieldValue.serverTimestamp(),
        });
        created++;
    }
    console.log(`[seedCountryExpansion] Created ${created}, skipped ${skipped}`);
    return { created, skipped };
});
//# sourceMappingURL=seedCountryExpansion.js.map