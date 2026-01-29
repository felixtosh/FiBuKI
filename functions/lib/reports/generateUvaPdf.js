"use strict";
/**
 * Cloud Function: Generate UVA PDF Report
 *
 * Generates a PDF document for the Austrian Umsatzsteuervoranmeldung (VAT advance return).
 * Uses the existing Puppeteer infrastructure for HTML to PDF conversion.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateUvaPdfCallable = void 0;
const createCallable_1 = require("../utils/createCallable");
const htmlToPdf_1 = require("../precision-search/htmlToPdf");
/**
 * Format amount from cents to EUR string
 */
function formatAmount(cents) {
    if (cents === 0)
        return "-";
    return (cents / 100).toLocaleString("de-AT", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}
/**
 * Format period for display
 */
function formatPeriod(period) {
    const monthNames = [
        "Jänner", "Februar", "März", "April", "Mai", "Juni",
        "Juli", "August", "September", "Oktober", "November", "Dezember"
    ];
    if (period.type === "monthly") {
        return `${monthNames[period.period - 1]} ${period.year}`;
    }
    else {
        return `${period.period}. Quartal ${period.year}`;
    }
}
/**
 * Generate row HTML for a Kennzahl
 */
function kzRow(kz, label, amount, isTotal = false) {
    const amountStr = formatAmount(amount);
    const style = isTotal ? "font-weight: bold; background-color: #f5f5f5;" : "";
    return `
    <tr style="${style}">
      <td style="padding: 8px; border: 1px solid #ddd; width: 80px; text-align: center; font-family: monospace;">${kz}</td>
      <td style="padding: 8px; border: 1px solid #ddd;">${label}</td>
      <td style="padding: 8px; border: 1px solid #ddd; text-align: right; font-family: monospace; width: 120px;">${amountStr} EUR</td>
    </tr>
  `;
}
/**
 * Generate UVA PDF HTML template
 */
function generateUvaPdfHtml(report, period, companyName, taxNumber) {
    const generatedDate = new Date().toLocaleDateString("de-AT");
    const periodStr = formatPeriod(period);
    // Calculate if there's a payment or refund
    const isPayment = report.vatBalance >= 0;
    const balanceColor = isPayment ? "#dc2626" : "#16a34a";
    const balanceLabel = isPayment ? "Zahllast" : "Gutschrift";
    return `
    <!DOCTYPE html>
    <html lang="de">
    <head>
      <meta charset="UTF-8">
      <style>
        * {
          box-sizing: border-box;
        }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          font-size: 12px;
          line-height: 1.4;
          color: #333;
          margin: 0;
          padding: 0;
        }
        .header {
          text-align: center;
          margin-bottom: 20px;
          padding-bottom: 15px;
          border-bottom: 2px solid #333;
        }
        .header h1 {
          margin: 0 0 5px 0;
          font-size: 18px;
          color: #1a1a1a;
        }
        .header h2 {
          margin: 0 0 10px 0;
          font-size: 14px;
          font-weight: normal;
          color: #666;
        }
        .meta-info {
          display: flex;
          justify-content: space-between;
          margin-bottom: 20px;
          padding: 10px;
          background-color: #f9f9f9;
          border-radius: 4px;
        }
        .meta-info div {
          text-align: left;
        }
        .meta-info .right {
          text-align: right;
        }
        .section {
          margin-bottom: 20px;
        }
        .section-title {
          font-size: 13px;
          font-weight: bold;
          color: #1a1a1a;
          margin-bottom: 8px;
          padding: 5px 8px;
          background-color: #e5e5e5;
          border-left: 3px solid #333;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 15px;
        }
        .summary-box {
          margin-top: 20px;
          padding: 15px;
          border: 2px solid ${balanceColor};
          border-radius: 8px;
          text-align: center;
        }
        .summary-box .label {
          font-size: 12px;
          color: #666;
          margin-bottom: 5px;
        }
        .summary-box .amount {
          font-size: 24px;
          font-weight: bold;
          color: ${balanceColor};
        }
        .footer {
          margin-top: 30px;
          padding-top: 15px;
          border-top: 1px solid #ddd;
          font-size: 10px;
          color: #999;
          text-align: center;
        }
        .transaction-summary {
          display: flex;
          justify-content: space-around;
          margin: 15px 0;
          padding: 10px;
          background-color: #f5f5f5;
          border-radius: 4px;
        }
        .transaction-summary .stat {
          text-align: center;
        }
        .transaction-summary .stat .number {
          font-size: 20px;
          font-weight: bold;
        }
        .transaction-summary .stat .label {
          font-size: 10px;
          color: #666;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Umsatzsteuervoranmeldung (U30)</h1>
        <h2>Zeitraum: ${periodStr}</h2>
      </div>

      <div class="meta-info">
        <div>
          ${companyName ? `<strong>${companyName}</strong><br>` : ""}
          ${taxNumber ? `Steuernummer: ${taxNumber}` : ""}
        </div>
        <div class="right">
          Erstellt am: ${generatedDate}
        </div>
      </div>

      ${report.transactionCount ? `
      <div class="transaction-summary">
        <div class="stat">
          <div class="number">${report.transactionCount.total}</div>
          <div class="label">Transaktionen</div>
        </div>
        <div class="stat">
          <div class="number" style="color: #16a34a;">${report.transactionCount.income}</div>
          <div class="label">Einnahmen</div>
        </div>
        <div class="stat">
          <div class="number" style="color: #dc2626;">${report.transactionCount.expense}</div>
          <div class="label">Ausgaben</div>
        </div>
        <div class="stat">
          <div class="number">${report.transactionCount.complete}</div>
          <div class="label">Vollständig</div>
        </div>
      </div>
      ` : ""}

      <div class="section">
        <div class="section-title">Umsätze (Lieferungen und Leistungen)</div>
        <table>
          ${report.taxableRevenue.rate20Net > 0 || report.taxableRevenue.rate20Vat > 0 ? `
          ${kzRow("KZ 000", "Steuerpflichtige Umsätze 20% (Netto)", report.taxableRevenue.rate20Net)}
          ${kzRow("KZ 001", "USt 20%", report.taxableRevenue.rate20Vat)}
          ` : ""}
          ${report.taxableRevenue.rate13Net > 0 || report.taxableRevenue.rate13Vat > 0 ? `
          ${kzRow("KZ 029", "Steuerpflichtige Umsätze 13% (Netto)", report.taxableRevenue.rate13Net)}
          ${kzRow("KZ 008", "USt 13%", report.taxableRevenue.rate13Vat)}
          ` : ""}
          ${report.taxableRevenue.rate10Net > 0 || report.taxableRevenue.rate10Vat > 0 ? `
          ${kzRow("KZ 006", "Steuerpflichtige Umsätze 10% (Netto)", report.taxableRevenue.rate10Net)}
          ${kzRow("KZ 007", "USt 10%", report.taxableRevenue.rate10Vat)}
          ` : ""}
        </table>
      </div>

      ${(report.exemptRevenue.exports > 0 || report.exemptRevenue.euDeliveries > 0 || report.exemptRevenue.other > 0) ? `
      <div class="section">
        <div class="section-title">Steuerfreie Umsätze</div>
        <table>
          ${report.exemptRevenue.exports > 0 ? kzRow("KZ 011", "Ausfuhrlieferungen", report.exemptRevenue.exports) : ""}
          ${report.exemptRevenue.euDeliveries > 0 ? kzRow("KZ 017", "Innergemeinschaftliche Lieferungen", report.exemptRevenue.euDeliveries) : ""}
          ${report.exemptRevenue.other > 0 ? kzRow("KZ 019", "Sonstige steuerfreie Umsätze", report.exemptRevenue.other) : ""}
        </table>
      </div>
      ` : ""}

      ${(report.euAcquisitions.netAmount > 0 || report.euAcquisitions.vatAmount > 0) ? `
      <div class="section">
        <div class="section-title">Innergemeinschaftliche Erwerbe</div>
        <table>
          ${kzRow("KZ 070", "Innergemeinschaftliche Erwerbe (Netto)", report.euAcquisitions.netAmount)}
          ${kzRow("KZ 071", "USt auf innergemeinschaftliche Erwerbe", report.euAcquisitions.vatAmount)}
        </table>
      </div>
      ` : ""}

      <div class="section">
        <div class="section-title">Vorsteuer</div>
        <table>
          ${kzRow("KZ 060", "Vorsteuer aus Rechnungen", report.inputVat.standard)}
          ${report.inputVat.euAcquisitions > 0 ? kzRow("KZ 061", "Vorsteuer aus innergemeinschaftlichen Erwerben", report.inputVat.euAcquisitions) : ""}
          ${report.inputVat.imports > 0 ? kzRow("KZ 083", "Entrichtete Einfuhrumsatzsteuer", report.inputVat.imports) : ""}
        </table>
      </div>

      <div class="section">
        <div class="section-title">Berechnung</div>
        <table>
          ${kzRow("KZ 095", "Summe der zu entrichtenden USt", report.totalVatPayable, true)}
          ${kzRow("KZ 090", "Summe der abziehbaren Vorsteuer", -report.totalInputVat, true)}
          ${kzRow("KZ 096", balanceLabel, report.vatBalance, true)}
        </table>
      </div>

      <div class="summary-box">
        <div class="label">${isPayment ? "Zu zahlender Betrag" : "Erstattungsbetrag"}</div>
        <div class="amount">${formatAmount(Math.abs(report.vatBalance))} EUR</div>
      </div>

      <div class="footer">
        Dieses Dokument wurde automatisch erstellt und dient nur zu Informationszwecken.<br>
        Für die offizielle Übermittlung verwenden Sie bitte FinanzOnline.
      </div>
    </body>
    </html>
  `;
}
exports.generateUvaPdfCallable = (0, createCallable_1.createCallable)({ name: "generateUvaPdf", memory: "1GiB", timeoutSeconds: 120 }, async (_ctx, request) => {
    const { report, period, companyName, taxNumber } = request;
    if (!report) {
        throw new createCallable_1.HttpsError("invalid-argument", "Report data is required");
    }
    if (!period) {
        throw new createCallable_1.HttpsError("invalid-argument", "Period is required");
    }
    // Generate HTML
    const html = generateUvaPdfHtml(report, period, companyName, taxNumber);
    // Convert to PDF
    const result = await (0, htmlToPdf_1.convertHtmlToPdf)(html);
    // Generate filename
    const periodStr = period.type === "monthly"
        ? `${period.year}-${period.period.toString().padStart(2, "0")}`
        : `${period.year}-Q${period.period}`;
    const filename = `UVA_${periodStr}.pdf`;
    return {
        success: true,
        pdfBase64: result.pdfBuffer.toString("base64"),
        filename,
        pageCount: result.pageCount,
    };
});
//# sourceMappingURL=generateUvaPdf.js.map