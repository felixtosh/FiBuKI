/**
 * List Bank Institutions Callable
 *
 * Lists available financial institutions from finAPI.
 * This callable has access to the finAPI secrets.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import { defineSecret } from "firebase-functions/params";

const FINAPI_CLIENT_ID = defineSecret("FINAPI_CLIENT_ID");
const FINAPI_CLIENT_SECRET = defineSecret("FINAPI_CLIENT_SECRET");

interface ListInstitutionsRequest {
  country: string;
}

interface Institution {
  id: string;
  name: string;
  logo?: string;
  bic?: string;
  countries: string[];
  transaction_total_days: string;
  providerId: string;
}

interface ListInstitutionsResponse {
  institutions: Institution[];
  provider: string;
}

export const listBankInstitutionsCallable = createCallable<
  ListInstitutionsRequest,
  ListInstitutionsResponse
>(
  {
    name: "listBankInstitutions",
    secrets: [FINAPI_CLIENT_ID, FINAPI_CLIENT_SECRET],
    allowUnauthenticated: true, // Public endpoint - listing banks doesn't need auth
  },
  async (ctx, request) => {
    const { country } = request;

    if (!country) {
      throw new HttpsError("invalid-argument", "Country code is required");
    }

    const clientId = FINAPI_CLIENT_ID.value();
    const clientSecret = FINAPI_CLIENT_SECRET.value();

    if (!clientId || !clientSecret) {
      throw new HttpsError(
        "failed-precondition",
        "finAPI credentials not configured"
      );
    }

    // Get client credentials token from finAPI
    const tokenResponse = await fetch(
      "https://sandbox.finapi.io/api/v2/oauth/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
        }),
      }
    );

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error("[listBankInstitutions] Token error:", errorText);
      throw new HttpsError("unavailable", "Failed to authenticate with finAPI");
    }

    const tokenData = (await tokenResponse.json()) as { access_token: string };
    const accessToken = tokenData.access_token;

    // List banks from finAPI
    const banksUrl = new URL("https://sandbox.finapi.io/api/v2/banks");
    banksUrl.searchParams.set("location", country.toUpperCase());
    banksUrl.searchParams.set("perPage", "500");
    banksUrl.searchParams.set("isSupported", "true");

    const banksResponse = await fetch(banksUrl.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!banksResponse.ok) {
      const errorText = await banksResponse.text();
      console.error("[listBankInstitutions] Banks error:", errorText);
      throw new HttpsError("unavailable", "Failed to fetch banks from finAPI");
    }

    const banksData = (await banksResponse.json()) as {
      banks: Array<{
        id: number;
        name: string;
        bic?: string;
        location?: string;
        logo?: { url?: string };
        psd2Role?: string;
      }>;
    };

    // Map all banks — don't deduplicate by name since different IDs may support different interfaces
    const institutions: Institution[] = banksData.banks.map((bank) => ({
      id: String(bank.id),
      name: bank.name,
      logo: bank.logo?.url,
      bic: bank.bic,
      countries: [country.toUpperCase()],
      transaction_total_days: "90", // finAPI default
      providerId: "finapi",
    }));

    // Disambiguate duplicate names by appending BIC or bank ID
    const nameCounts = new Map<string, number>();
    for (const inst of institutions) {
      nameCounts.set(inst.name, (nameCounts.get(inst.name) || 0) + 1);
    }
    for (const inst of institutions) {
      if ((nameCounts.get(inst.name) || 0) > 1) {
        const suffix = inst.bic || `#${inst.id}`;
        inst.name = `${inst.name} (${suffix})`;
      }
    }

    // Sort by name
    institutions.sort((a, b) => a.name.localeCompare(b.name));

    return {
      institutions,
      provider: "finapi",
    };
  }
);
