"use strict";
/**
 * Budget warning email template builders.
 * Extracted from inline HTML in sendUsageWarning.ts.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildBudgetWarningSubject = buildBudgetWarningSubject;
exports.buildBudgetWarningHtml = buildBudgetWarningHtml;
exports.buildBudgetWarningText = buildBudgetWarningText;
const emailLayout_1 = require("../emails/emailLayout");
function buildBudgetWarningSubject(percent) {
    return percent >= 100
        ? "AI budget exhausted \u2014 auto-matching paused"
        : "You've used 90% of your AI budget";
}
function buildBudgetWarningHtml(data) {
    const { name, percent, usageEur, limitEur } = data;
    let body = (0, emailLayout_1.emailGreeting)(name);
    if (percent >= 100) {
        body += `<p style="margin:0 0 16px;">You've used <strong>${usageEur.toFixed(2)}\u00a0EUR</strong> of your <strong>${limitEur.toFixed(2)}\u00a0EUR</strong> AI budget this period.</p>`;
        body += `<p style="margin:0 0 16px;">Auto-matching has been <strong>paused</strong> to prevent unexpected charges. Your files will continue to be extracted, but AI-powered partner lookup and agentic matching are on hold.</p>`;
        body += `<p style="margin:0 0 8px;">To resume:</p>`;
        body += `<ul style="margin:0 0 16px;padding-left:20px;color:#374151;">
  <li>Add AI credits in your billing settings</li>
  <li>Or upgrade your plan for a higher budget</li>
</ul>`;
    }
    else {
        body += `<p style="margin:0 0 16px;">You've used <strong>${usageEur.toFixed(2)}\u00a0EUR</strong> of your <strong>${limitEur.toFixed(2)}\u00a0EUR</strong> AI budget this period (<strong>90%</strong>).</p>`;
        body += `<p style="margin:0 0 16px;">Once you reach 100%, auto-matching will be paused.</p>`;
        body += `<p style="margin:0 0 8px;">To avoid interruptions:</p>`;
        body += `<ul style="margin:0 0 16px;padding-left:20px;color:#374151;">
  <li>Add AI credits in your billing settings</li>
  <li>Set an overage cap to allow spending beyond your limit</li>
  <li>Or upgrade your plan for a higher budget</li>
</ul>`;
    }
    body += (0, emailLayout_1.emailButton)("Manage Budget", "https://fibuki.com/settings/billing");
    const footerHtml = data.unsubscribeUrl
        ? `<p style="color:#9ca3af;font-size:12px;margin:0;">
        Sent by FiBuKI &middot; <a href="https://fibuki.com" style="color:#9ca3af;text-decoration:underline;">fibuki.com</a>
        &middot; <a href="${data.unsubscribeUrl}" style="color:#9ca3af;text-decoration:underline;">Unsubscribe</a>
      </p>`
        : undefined;
    return (0, emailLayout_1.wrapEmailHtml)(body, { footerHtml });
}
function buildBudgetWarningText(data) {
    const { name, percent, usageEur, limitEur } = data;
    const greeting = name ? `Hi ${name.split(" ")[0]},` : "Hi,";
    if (percent >= 100) {
        return [
            greeting,
            "",
            `You've used ${usageEur.toFixed(2)} EUR of your ${limitEur.toFixed(2)} EUR AI budget this period.`,
            "",
            "Auto-matching has been paused to prevent unexpected charges. Your files will continue to be extracted, but AI-powered partner lookup and agentic matching are on hold.",
            "",
            "To resume:",
            "- Add AI credits at https://fibuki.com/settings/billing",
            "- Or upgrade your plan for a higher budget",
        ].join("\n");
    }
    return [
        greeting,
        "",
        `You've used ${usageEur.toFixed(2)} EUR of your ${limitEur.toFixed(2)} EUR AI budget this period (90%).`,
        "",
        "Once you reach 100%, auto-matching will be paused.",
        "",
        "To avoid interruptions:",
        "- Add AI credits at https://fibuki.com/settings/billing",
        "- Set an overage cap to allow spending beyond your limit",
        "- Or upgrade your plan for a higher budget",
    ].join("\n");
}
//# sourceMappingURL=budgetWarningEmail.js.map