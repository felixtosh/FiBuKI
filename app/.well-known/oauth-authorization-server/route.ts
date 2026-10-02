/**
 * OAuth authorization server metadata (RFC 8414): https://fibuki.com/.well-known/oauth-authorization-server
 * The document itself is built in functions/src/oauth so the issuer and the resource cannot disagree.
 */

import type { NextRequest } from "next/server";
import { oauthPreflight, proxyOAuth } from "@/lib/api/oauth-proxy";

export const dynamic = "force-dynamic";

export const GET = (request: NextRequest) => proxyOAuth(request, "oauthMetadata", { doc: "authorization-server" });
export const OPTIONS = oauthPreflight;
