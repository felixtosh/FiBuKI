/** Token endpoint (RFC 6749): https://fibuki.com/api/oauth/token. Form or JSON body, forwarded as sent. */

import type { NextRequest } from "next/server";
import { oauthPreflight, proxyOAuth } from "@/lib/api/oauth-proxy";

export const dynamic = "force-dynamic";

export const POST = (request: NextRequest) => proxyOAuth(request, "oauthToken");
export const OPTIONS = oauthPreflight;
