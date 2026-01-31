export const dynamic = "force-dynamic";

/**
 * Banking Institutions API
 *
 * Lists available financial institutions from finAPI.
 * Proxies to the listBankInstitutions Cloud Function which has access to secrets.
 */

import { NextRequest, NextResponse } from "next/server";
import { callCloudFunction, setAuthToken } from "@/lib/firebase/callable-server";

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

export async function GET(request: NextRequest) {
  // Set auth token for Cloud Function calls
  setAuthToken(request.headers.get("Authorization"));

  try {
    const { searchParams } = new URL(request.url);
    const countryCode = searchParams.get("country");

    if (!countryCode) {
      return NextResponse.json(
        { error: "Country code is required" },
        { status: 400 }
      );
    }

    // Call the Cloud Function (no auth required for listing banks)
    const result = await callCloudFunction<
      ListInstitutionsRequest,
      ListInstitutionsResponse
    >("listBankInstitutions", {
      country: countryCode,
    });

    return NextResponse.json({
      institutions: result.institutions,
      providers: [result.provider],
    });
  } catch (error) {
    console.error("[Banking API] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch institutions" },
      { status: 500 }
    );
  }
}
