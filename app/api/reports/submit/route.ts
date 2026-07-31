export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { callFirebaseFunction } from "@/lib/api/firebase-callable";

interface ReportPeriod {
  year: number;
  period: number;
  type: "monthly" | "quarterly";
}

interface UVAReportData {
  taxableRevenue: {
    rate20Net: number;
    rate20Vat: number;
    rate10Net: number;
    rate10Vat: number;
    rate13Net: number;
    rate13Vat: number;
  };
  exemptRevenue: {
    exports: number;
    euDeliveries: number;
    other: number;
  };
  euAcquisitions: {
    netAmount: number;
    vatAmount: number;
  };
  inputVat: {
    standard: number;
    euAcquisitions: number;
    imports: number;
  };
  totalVatPayable: number;
  totalInputVat: number;
  vatBalance: number;
}

interface SubmitRequest {
  report: UVAReportData;
  period: ReportPeriod;
  taxNumber: string;
}

interface SubmitResponse {
  success: boolean;
  referenceNumber?: string;
  submissionId?: string;
  error?: string;
}

/**
 * POST /api/reports/submit
 *
 * Submit UVA report to FinanzOnline via WebService.
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const authHeader = request.headers.get("Authorization");
    const authToken = authHeader?.startsWith("Bearer ")
      ? authHeader.substring(7)
      : undefined;

    const body: SubmitRequest = await request.json();
    const { report, period, taxNumber } = body;

    // Validate required fields
    if (!report) {
      return NextResponse.json(
        { error: "report data is required" },
        { status: 400 }
      );
    }

    if (!period) {
      return NextResponse.json(
        { error: "period is required" },
        { status: 400 }
      );
    }

    if (!taxNumber || !/^\d{9}$/.test(taxNumber)) {
      return NextResponse.json(
        { error: "Tax number (9 digits) is required" },
        { status: 400 }
      );
    }

    const response = await callFirebaseFunction<SubmitRequest, SubmitResponse>(
      "submitUvaToFinanzOnline",
      { report, period, taxNumber },
      authToken
    );

    return NextResponse.json(response);
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[API] reports/submit error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}
