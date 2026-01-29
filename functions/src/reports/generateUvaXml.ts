/**
 * Cloud Function: Generate UVA XML for FinanzOnline
 *
 * Generates XML file in BMF (Austrian Ministry of Finance) format
 * for electronic submission of Umsatzsteuervoranmeldung (VAT advance return).
 */

import { createCallable, HttpsError } from "../utils/createCallable";

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

interface GenerateUvaXmlRequest {
  report: UVAReportData;
  period: ReportPeriod;
  taxNumber: string; // FASTNR - 9 digits
}

interface GenerateUvaXmlResponse {
  success: boolean;
  xmlBase64: string;
  filename: string;
}

/**
 * Format amount for XML (cents to euros with 2 decimal places)
 * Returns empty string if amount is 0
 */
function formatAmount(cents: number): string {
  if (cents === 0) return "";
  const euros = cents / 100;
  return euros.toFixed(2);
}

/**
 * Get period date range strings in YYYY-MM format
 */
function getPeriodRange(period: ReportPeriod): { from: string; to: string } {
  const year = period.year;

  if (period.type === "monthly") {
    const month = period.period.toString().padStart(2, "0");
    return {
      from: `${year}-${month}`,
      to: `${year}-${month}`,
    };
  } else {
    // Quarterly
    const startMonth = ((period.period - 1) * 3 + 1).toString().padStart(2, "0");
    const endMonth = (period.period * 3).toString().padStart(2, "0");
    return {
      from: `${year}-${startMonth}`,
      to: `${year}-${endMonth}`,
    };
  }
}

/**
 * Generate XML element with optional value (skip if empty)
 */
function xmlElement(tag: string, value: string | number): string {
  const strValue = typeof value === "number" ? formatAmount(value) : value;
  if (!strValue) return "";
  return `      <${tag}>${strValue}</${tag}>\n`;
}

/**
 * Generate UVA XML in FinanzOnline format
 */
function generateUvaXml(
  report: UVAReportData,
  period: ReportPeriod,
  taxNumber: string
): string {
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0]; // YYYY-MM-DD
  const timeStr = now.toTimeString().split(" ")[0]; // HH:MM:SS
  const periodRange = getPeriodRange(period);

  // Build U30 section with KZ codes
  let u30Content = "";

  // Revenue at 20%
  u30Content += xmlElement("KZ000", report.taxableRevenue.rate20Net);
  u30Content += xmlElement("KZ001", report.taxableRevenue.rate20Vat);

  // Revenue at 10%
  u30Content += xmlElement("KZ006", report.taxableRevenue.rate10Net);
  u30Content += xmlElement("KZ007", report.taxableRevenue.rate10Vat);

  // Revenue at 13%
  u30Content += xmlElement("KZ029", report.taxableRevenue.rate13Net);
  u30Content += xmlElement("KZ008", report.taxableRevenue.rate13Vat);

  // Exempt revenue
  u30Content += xmlElement("KZ011", report.exemptRevenue.exports);
  u30Content += xmlElement("KZ017", report.exemptRevenue.euDeliveries);
  u30Content += xmlElement("KZ019", report.exemptRevenue.other);

  // EU acquisitions
  u30Content += xmlElement("KZ070", report.euAcquisitions.netAmount);
  u30Content += xmlElement("KZ071", report.euAcquisitions.vatAmount);

  // Input VAT
  u30Content += xmlElement("KZ060", report.inputVat.standard);
  u30Content += xmlElement("KZ061", report.inputVat.euAcquisitions);
  u30Content += xmlElement("KZ083", report.inputVat.imports);

  // Totals
  u30Content += xmlElement("KZ095", report.totalVatPayable);
  u30Content += xmlElement("KZ090", report.totalInputVat);
  u30Content += xmlElement("KZ096", report.vatBalance);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ERKLAERUNGS_UEBERMITTLUNG xmlns="http://www.bmf.gv.at/erklaerung/uebermittlung">
  <INFO_DATEN>
    <ART_IDENTIFIKATIONSBEGRIFF>FASTNR</ART_IDENTIFIKATIONSBEGRIFF>
    <IDENTIFIKATIONSBEGRIFF>${taxNumber}</IDENTIFIKATIONSBEGRIFF>
    <PAKET_NR>1</PAKET_NR>
    <DATUM_ERSTELLUNG>${dateStr}</DATUM_ERSTELLUNG>
    <UHRZEIT_ERSTELLUNG>${timeStr}</UHRZEIT_ERSTELLUNG>
    <ANZAHL_ERKLAERUNGEN>1</ANZAHL_ERKLAERUNGEN>
  </INFO_DATEN>
  <ERKLAERUNG>
    <SATZNR>1</SATZNR>
    <ALLGEMEINE_DATEN>
      <ANBRINGEN>U30</ANBRINGEN>
      <ZESSION>N</ZESSION>
      <FASESSION>N</FASESSION>
      <ZRVON>${periodRange.from}</ZRVON>
      <ZRBIS>${periodRange.to}</ZRBIS>
    </ALLGEMEINE_DATEN>
    <U30>
${u30Content}    </U30>
  </ERKLAERUNG>
</ERKLAERUNGS_UEBERMITTLUNG>`;

  return xml;
}

export const generateUvaXmlCallable = createCallable<
  GenerateUvaXmlRequest,
  GenerateUvaXmlResponse
>(
  { name: "generateUvaXml" },
  async (_ctx, request) => {
    const { report, period, taxNumber } = request;

    // Validate tax number
    if (!taxNumber || !/^\d{9}$/.test(taxNumber)) {
      throw new HttpsError(
        "invalid-argument",
        "Tax number (FASTNR) must be exactly 9 digits"
      );
    }

    if (!report) {
      throw new HttpsError("invalid-argument", "Report data is required");
    }

    if (!period) {
      throw new HttpsError("invalid-argument", "Period is required");
    }

    // Generate XML
    const xml = generateUvaXml(report, period, taxNumber);

    // Generate filename
    const periodStr =
      period.type === "monthly"
        ? `${period.year}-${period.period.toString().padStart(2, "0")}`
        : `${period.year}-Q${period.period}`;
    const filename = `UVA_${periodStr}.xml`;

    return {
      success: true,
      xmlBase64: Buffer.from(xml, "utf-8").toString("base64"),
      filename,
    };
  }
);
