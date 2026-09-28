/**
 * POST /api/mail/search: search any connected mailbox (#245).
 *
 * The provider-neutral name for /api/gmail/search, which already searches
 * every Mail Provider through searchGmailCallable (#240). One handler, two
 * paths: the Gmail-named one stays for the callers that still use it.
 */
export const dynamic = "force-dynamic";
export { POST } from "@/app/api/gmail/search/route";
