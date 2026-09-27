/**
 * /api/mail/attachment: preview (GET) or attach (POST) one mail attachment,
 * from any connected mailbox (#245).
 *
 * The provider-neutral name for /api/gmail/attachment. Gmail is read with its
 * own client there; every other provider through the provider factory.
 */
export const dynamic = "force-dynamic";
export { GET, POST } from "@/app/api/gmail/attachment/route";
