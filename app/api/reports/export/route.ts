export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerUserIdWithFallback } from "@/lib/auth/get-server-user";
import { callFirebaseFunction } from "@/lib/api/firebase-callable";

// Types for the API
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
  breakdown?: Array<{
    rate: number;
    netAmount: number;
    vatAmount: number;
    grossAmount: number;
    transactionCount: number;
  }>;
  transactionCount?: {
    total: number;
    income: number;
    expense: number;
    complete: number;
    incomplete: number;
  };
}

interface ExportRequest {
  format: "pdf" | "xml";
  report: UVAReportData;
  period: ReportPeriod;
  taxNumber?: string;
  companyName?: string;
}

interface PdfExportResponse {
  success: boolean;
  pdfBase64: string;
  filename: string;
  pageCount: number;
}

interface XmlExportResponse {
  success: boolean;
  xmlBase64: string;
  filename: string;
}

/**
 * POST /api/reports/export
 *
 * Export UVA report as PDF or XML for FinanzOnline.
 */
export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const userId = await getServerUserIdWithFallback(request);
    if (!userId) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    // Get auth token from header to pass to Firebase callable
    const authHeader = request.headers.get("Authorization");
    const authToken = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : undefined;

    const body: ExportRequest = await request.json();
    const { format, report, period, taxNumber, companyName } = body;

    // Validate required fields
    if (!format || !["pdf", "xml"].includes(format)) {
      return NextResponse.json(
        { error: "format must be 'pdf' or 'xml'" },
        { status: 400 }
      );
    }

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

    if (format === "xml") {
      // XML export requires tax number
      if (!taxNumber || !/^\d{9}$/.test(taxNumber)) {
        return NextResponse.json(
          { error: "Tax number (9 digits) is required for XML export" },
          { status: 400 }
        );
      }

      const response = await callFirebaseFunction<
        { report: UVAReportData; period: ReportPeriod; taxNumber: string },
        XmlExportResponse
      >(
        "generateUvaXml",
        { report, period, taxNumber },
        authToken
      );

      return NextResponse.json({
        success: true,
        data: response.xmlBase64,
        filename: response.filename,
        mimeType: "application/xml",
      });
    } else {
      // PDF export
      const response = await callFirebaseFunction<
        { report: UVAReportData; period: ReportPeriod; companyName?: string; taxNumber?: string },
        PdfExportResponse
      >(
        "generateUvaPdf",
        { report, period, companyName, taxNumber },
        authToken
      );

      return NextResponse.json({
        success: true,
        data: response.pdfBase64,
        filename: response.filename,
        mimeType: "application/pdf",
        pageCount: response.pageCount,
      });
    }
  } catch (error) {
    console.error("[API] reports/export error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
