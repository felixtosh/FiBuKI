/**
 * HTML email template builder for weekly digest.
 */

export interface DigestStats {
  newTransactions: number;
  unmatchedTransactions: number;
  completionRate: number;
  newFiles: number;
}

export function buildDigestSubject(stats: DigestStats): string {
  return `Your FiBuKI week: ${stats.newTransactions} new transaction${stats.newTransactions === 1 ? "" : "s"}`;
}

export function buildDigestHtml(
  stats: DigestStats,
  unsubscribeUrl: string
): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your FiBuKI Weekly Digest</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f9fafb;color:#1f2937;">
  <div style="max-width:560px;margin:0 auto;padding:32px 16px;">
    <!-- Header -->
    <div style="text-align:center;margin-bottom:24px;">
      <h1 style="font-size:24px;font-weight:700;margin:0 0 4px;">FiBuKI</h1>
      <p style="color:#6b7280;font-size:14px;margin:0;">Weekly Digest</p>
    </div>

    <!-- Card -->
    <div style="background:#fff;border-radius:12px;padding:24px;border:1px solid #e5e7eb;">
      <h2 style="font-size:18px;margin:0 0 16px;font-weight:600;">
        Here&rsquo;s your week at a glance
      </h2>

      <!-- Stats Grid -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
        <tr>
          <td style="padding:8px 0;">
            <span style="font-size:28px;font-weight:700;">${stats.newTransactions}</span>
            <br/>
            <span style="color:#6b7280;font-size:13px;">New transactions</span>
          </td>
          <td style="padding:8px 0;text-align:right;">
            <span style="font-size:28px;font-weight:700;color:${stats.completionRate >= 80 ? "#16a34a" : stats.completionRate >= 50 ? "#d97706" : "#dc2626"};">${stats.completionRate}%</span>
            <br/>
            <span style="color:#6b7280;font-size:13px;">Matched with receipts</span>
          </td>
        </tr>
      </table>

      ${stats.unmatchedTransactions > 0 ? `
      <div style="background:#fef3c7;border-radius:8px;padding:12px 16px;margin-bottom:16px;">
        <span style="font-size:14px;color:#92400e;">
          <strong>${stats.unmatchedTransactions}</strong> transaction${stats.unmatchedTransactions === 1 ? "" : "s"} still need${stats.unmatchedTransactions === 1 ? "s" : ""} receipts
        </span>
      </div>` : ""}

      ${stats.newFiles > 0 ? `
      <p style="color:#6b7280;font-size:14px;margin:0 0 16px;">
        ${stats.newFiles} new file${stats.newFiles === 1 ? "" : "s"} uploaded this week.
      </p>` : ""}

      <!-- CTA -->
      <div style="text-align:center;margin-top:20px;">
        <a href="https://fibuki.com/transactions" style="display:inline-block;background:#18181b;color:#fff;padding:10px 28px;border-radius:6px;text-decoration:none;font-weight:500;font-size:14px;">
          Open FiBuKI
        </a>
      </div>
    </div>

    <!-- Footer -->
    <div style="text-align:center;margin-top:24px;">
      <p style="color:#9ca3af;font-size:12px;margin:0;">
        You&rsquo;re receiving this because you have a FiBuKI account.
        <br/>
        <a href="${unsubscribeUrl}" style="color:#9ca3af;text-decoration:underline;">Unsubscribe from weekly digests</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

export function buildDigestText(
  stats: DigestStats,
  unsubscribeUrl: string
): string {
  const lines = [
    "Your FiBuKI Weekly Digest",
    "",
    "Here's your week at a glance:",
    "",
    `- ${stats.newTransactions} new transactions`,
    `- ${stats.completionRate}% matched with receipts`,
  ];

  if (stats.unmatchedTransactions > 0) {
    lines.push(`- ${stats.unmatchedTransactions} still need receipts`);
  }

  if (stats.newFiles > 0) {
    lines.push(`- ${stats.newFiles} new files uploaded`);
  }

  lines.push(
    "",
    "Open FiBuKI: https://fibuki.com/transactions",
    "",
    `Unsubscribe: ${unsubscribeUrl}`
  );

  return lines.join("\n");
}
