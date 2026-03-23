/**
 * Admin-only: Activate a country after it reaches its backer threshold.
 * Sets status to "active" and sends notification emails to all backers.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import { FieldValue } from "firebase-admin/firestore";

interface ActivateCountryRequest {
  countryCode: string;
}

interface ActivateCountryResponse {
  success: boolean;
  backerCount: number;
}

export const activateCountryCallable = createCallable<
  ActivateCountryRequest,
  ActivateCountryResponse
>(
  { name: "activateCountry" },
  async (ctx, request) => {
    const { countryCode } = request;

    if (!countryCode) {
      throw new HttpsError("invalid-argument", "countryCode is required");
    }

    // Admin check
    const isAdmin = ctx.request.auth?.token?.admin === true;
    const isSuperAdmin = ctx.request.auth?.token?.email === process.env.SUPER_ADMIN_EMAIL;
    if (!isAdmin && !isSuperAdmin) {
      throw new HttpsError("permission-denied", "Admin access required");
    }

    const countryRef = ctx.db.collection("countryExpansion").doc(countryCode);
    const countryDoc = await countryRef.get();

    if (!countryDoc.exists) {
      throw new HttpsError("not-found", `Country ${countryCode} not found`);
    }

    const countryData = countryDoc.data()!;
    if (countryData.status === "active") {
      throw new HttpsError("already-exists", "Country is already active");
    }

    // Update country status
    await countryRef.update({
      status: "active",
      activatedAt: FieldValue.serverTimestamp(),
    });

    // Get all backers for this country
    const backersSnap = await ctx.db
      .collection("countryBackers")
      .where("countryCode", "==", countryCode)
      .where("status", "==", "paid")
      .get();

    // TODO: Send "Your country is live!" email to all backers via SendGrid
    // For now, log the backer emails
    const backerEmails = backersSnap.docs.map((d) => d.data().email);
    console.log(
      `[activateCountry] ${countryCode} activated. Backers to notify:`,
      backerEmails
    );

    return {
      success: true,
      backerCount: backersSnap.size,
    };
  }
);
