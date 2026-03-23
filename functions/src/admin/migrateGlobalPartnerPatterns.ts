import { onCall } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";

const FIREBASE_PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "taxstudio-f12fb";
const CORS_ORIGINS = [
  process.env.APP_URL || "https://fibuki.com",
  `https://${FIREBASE_PROJECT_ID}.firebaseapp.com`,
  `https://${FIREBASE_PROJECT_ID}.web.app`,
  "http://localhost:3000",
];

const db = getFirestore();

/**
 * Pattern definitions for global partners
 * Matches preset-partners.ts in the client
 */
const GLOBAL_PARTNER_PATTERNS: Record<string, Array<{ pattern: string; field: "partner" | "name"; confidence: number }>> = {
  // Big Tech
  "Apple Inc.": [
    { pattern: "*apple*", field: "name", confidence: 92 },
    { pattern: "*itunes*", field: "name", confidence: 92 },
    { pattern: "*icloud*", field: "name", confidence: 92 },
  ],
  "Amazon.com, Inc.": [
    { pattern: "*amazon*", field: "name", confidence: 92 },
    { pattern: "*amzn*", field: "name", confidence: 92 },
    { pattern: "*prime video*", field: "name", confidence: 90 },
  ],
  "Alphabet Inc.": [
    { pattern: "*google*", field: "name", confidence: 92 },
    { pattern: "*youtube*", field: "name", confidence: 92 },
  ],
  "Meta Platforms, Inc.": [
    { pattern: "*facebook*", field: "name", confidence: 92 },
    { pattern: "*instagram*", field: "name", confidence: 92 },
    { pattern: "*whatsapp*", field: "name", confidence: 92 },
    { pattern: "*meta platforms*", field: "name", confidence: 92 },
  ],
  "Netflix, Inc.": [
    { pattern: "*netflix*", field: "name", confidence: 95 },
  ],
  "Microsoft Corporation": [
    { pattern: "*microsoft*", field: "name", confidence: 92 },
    { pattern: "*msft*", field: "name", confidence: 90 },
    { pattern: "*azure*", field: "name", confidence: 90 },
    { pattern: "*github*", field: "name", confidence: 92 },
    { pattern: "*linkedin*", field: "name", confidence: 92 },
  ],
  "Tesla, Inc.": [
    { pattern: "*tesla*", field: "name", confidence: 92 },
  ],
  "Adobe Inc.": [
    { pattern: "*adobe*", field: "name", confidence: 92 },
  ],
  "Salesforce, Inc.": [
    { pattern: "*salesforce*", field: "name", confidence: 92 },
  ],

  // Streaming & Entertainment
  "Spotify Technology S.A.": [
    { pattern: "*spotify*", field: "name", confidence: 95 },
  ],
  "The Walt Disney Company": [
    { pattern: "*disney*", field: "name", confidence: 92 },
  ],

  // Fintech & Payments
  "PayPal Holdings, Inc.": [
    { pattern: "*paypal*", field: "name", confidence: 95 },
    { pattern: "*venmo*", field: "name", confidence: 92 },
  ],
  "Klarna Bank AB": [
    { pattern: "*klarna*", field: "name", confidence: 95 },
  ],
  "Revolut Ltd": [
    { pattern: "*revolut*", field: "name", confidence: 95 },
  ],
  "N26 Bank GmbH": [
    { pattern: "*n26*", field: "name", confidence: 92 },
  ],
  "Wise Payments Limited": [
    { pattern: "*wise*", field: "name", confidence: 85 },
    { pattern: "*transferwise*", field: "name", confidence: 95 },
  ],
  "Stripe, Inc.": [
    { pattern: "*stripe*", field: "name", confidence: 92 },
  ],
  "Block, Inc.": [
    { pattern: "*square*", field: "name", confidence: 90 },
    { pattern: "*cash app*", field: "name", confidence: 92 },
  ],
  "American Express Company": [
    { pattern: "*amex*", field: "name", confidence: 90 },
    { pattern: "*american express*", field: "name", confidence: 92 },
  ],
  "Sumup Limited": [
    { pattern: "*sumup*", field: "name", confidence: 92 },
  ],
  "iZettle AB": [
    { pattern: "*zettle*", field: "name", confidence: 92 },
    { pattern: "*izettle*", field: "name", confidence: 92 },
  ],
  "Mollie B.V.": [
    { pattern: "*mollie*", field: "name", confidence: 90 },
  ],
  "Adyen N.V.": [
    { pattern: "*adyen*", field: "name", confidence: 92 },
  ],

  // Tech Services
  "Uber Technologies, Inc.": [
    { pattern: "*uber*", field: "name", confidence: 92 },
  ],
  "Lyft, Inc.": [
    { pattern: "*lyft*", field: "name", confidence: 92 },
  ],
  "Airbnb, Inc.": [
    { pattern: "*airbnb*", field: "name", confidence: 95 },
  ],
  "DoorDash, Inc.": [
    { pattern: "*doordash*", field: "name", confidence: 92 },
  ],
  "Dropbox, Inc.": [
    { pattern: "*dropbox*", field: "name", confidence: 95 },
  ],
  "Zoom Video Communications, Inc.": [
    { pattern: "*zoom*", field: "name", confidence: 90 },
  ],
  "Slack Technologies, LLC": [
    { pattern: "*slack*", field: "name", confidence: 90 },
  ],
  "Atlassian Corporation": [
    { pattern: "*atlassian*", field: "name", confidence: 92 },
    { pattern: "*jira*", field: "name", confidence: 90 },
    { pattern: "*confluence*", field: "name", confidence: 90 },
    { pattern: "*trello*", field: "name", confidence: 92 },
  ],
  "Autodesk, Inc.": [
    { pattern: "*autodesk*", field: "name", confidence: 92 },
  ],
  "Shopify Inc.": [
    { pattern: "*shopify*", field: "name", confidence: 92 },
  ],

  // Cloud
  "Amazon Web Services, Inc.": [
    { pattern: "*aws*", field: "name", confidence: 90 },
  ],
  "Cloudflare, Inc.": [
    { pattern: "*cloudflare*", field: "name", confidence: 92 },
  ],
  "DigitalOcean, LLC": [
    { pattern: "*digitalocean*", field: "name", confidence: 92 },
  ],
  "Vercel Inc.": [
    { pattern: "*vercel*", field: "name", confidence: 92 },
  ],
  "Netlify, Inc.": [
    { pattern: "*netlify*", field: "name", confidence: 92 },
  ],
  "Supabase, Inc.": [
    { pattern: "*supabase*", field: "name", confidence: 92 },
  ],
  "MongoDB, Inc.": [
    { pattern: "*mongodb*", field: "name", confidence: 92 },
  ],
  "Twilio Inc.": [
    { pattern: "*twilio*", field: "name", confidence: 92 },
  ],
  "HubSpot, Inc.": [
    { pattern: "*hubspot*", field: "name", confidence: 92 },
  ],
  "Notion Labs, Inc.": [
    { pattern: "*notion*", field: "name", confidence: 90 },
  ],
  "Figma, Inc.": [
    { pattern: "*figma*", field: "name", confidence: 92 },
  ],
  "Canva Pty Ltd": [
    { pattern: "*canva*", field: "name", confidence: 92 },
  ],
  "Airtable Inc.": [
    { pattern: "*airtable*", field: "name", confidence: 92 },
  ],

  // Retail
  "IKEA of Sweden AB": [
    { pattern: "*ikea*", field: "name", confidence: 92 },
  ],
  "Zalando SE": [
    { pattern: "*zalando*", field: "name", confidence: 92 },
  ],
  "eBay Inc.": [
    { pattern: "*ebay*", field: "name", confidence: 92 },
  ],
  "Etsy, Inc.": [
    { pattern: "*etsy*", field: "name", confidence: 92 },
  ],
  "Booking Holdings Inc.": [
    { pattern: "*booking*", field: "name", confidence: 90 },
  ],
};

/**
 * Migrate patterns to existing globalPartners in Firestore
 * Run this once to add patterns to existing global partners
 */
export const migrateGlobalPartnerPatterns = onCall(
  { region: "europe-west1", cors: CORS_ORIGINS },
  async (request) => {
    // Get all global partners
    const globalPartnersSnapshot = await db
      .collection("globalPartners")
      .where("isActive", "==", true)
      .get();

    const batch = db.batch();
    let updated = 0;
    let skipped = 0;

    for (const doc of globalPartnersSnapshot.docs) {
      const data = doc.data();
      const partnerName = data.name;

      // Check if we have patterns for this partner
      const patterns = GLOBAL_PARTNER_PATTERNS[partnerName];

      if (patterns) {
        batch.update(doc.ref, { patterns });
        updated++;
        console.log(`Adding patterns to ${partnerName}`);
      } else {
        skipped++;
      }
    }

    if (updated > 0) {
      await batch.commit();
    }

    console.log(`Migration complete: ${updated} updated, ${skipped} skipped`);

    return {
      success: true,
      updated,
      skipped,
      total: globalPartnersSnapshot.size,
    };
  }
);
