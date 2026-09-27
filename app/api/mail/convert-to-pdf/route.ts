/**
 * POST /api/mail/convert-to-pdf: turn a mail itself into a File, from any
 * connected mailbox (#245). The provider-neutral name for
 * /api/gmail/convert-to-pdf.
 */
export const dynamic = "force-dynamic";
export { POST } from "@/app/api/gmail/convert-to-pdf/route";
