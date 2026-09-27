/**
 * POST /api/mail/email-content: one message's body, from any connected
 * mailbox (#245). The provider-neutral name for /api/gmail/email-content.
 */
export const dynamic = "force-dynamic";
export { POST } from "@/app/api/gmail/email-content/route";
