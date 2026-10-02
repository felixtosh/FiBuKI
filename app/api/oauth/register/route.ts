/** Dynamic client registration (RFC 7591): https://fibuki.com/api/oauth/register */

import type { NextRequest } from "next/server";
import { oauthPreflight, proxyOAuth } from "@/lib/api/oauth-proxy";

export const dynamic = "force-dynamic";

export const POST = (request: NextRequest) => proxyOAuth(request, "oauthRegister");
export const OPTIONS = oauthPreflight;
