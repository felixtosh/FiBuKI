/**
 * Shared email layout wrapper for all FiBuKI email templates.
 * Provides consistent branding, spacing, and styling.
 */

const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * Wrap template body in the shared email layout.
 */
export function wrapEmailHtml(
  body: string,
  opts?: { footerHtml?: string }
): string {
  const footer =
    opts?.footerHtml ??
    `<p style="color:#9ca3af;font-size:12px;margin:0;">
      Sent by FiBuKI &middot; <a href="https://fibuki.com" style="color:#9ca3af;text-decoration:underline;">fibuki.com</a>
    </p>`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;font-family:${FONT_STACK};background:#ffffff;color:#1f2937;">
  <div style="max-width:560px;margin:0 auto;padding:40px 16px 32px;">
    <!-- Logo -->
    <div style="margin-bottom:32px;">
      <img src="https://fibuki.com/email-image.png" alt="FiBuKI" style="height:40px;width:auto;" />
    </div>

    <!-- Content -->
    <div style="line-height:1.7;font-size:15px;color:#374151;">
      ${body}
    </div>

    <!-- Footer -->
    <div style="margin-top:32px;padding-top:20px;border-top:1px solid #e5e7eb;">
      ${footer}
    </div>
  </div>
</body>
</html>`;
}

/**
 * Render a small dark CTA button.
 */
export function emailButton(label: string, href: string): string {
  return `<div style="margin:24px 0;">
  <a href="${href}" style="display:inline-block;background:#18181b;color:#ffffff;padding:8px 20px;border-radius:6px;text-decoration:none;font-weight:500;font-size:13px;">${label}</a>
</div>`;
}

/**
 * Render a greeting line.
 */
export function emailGreeting(name?: string): string {
  const who = name ? name.split(" ")[0] : null;
  return `<p style="margin:0 0 16px;">Hi${who ? ` ${who}` : ""},</p>`;
}
