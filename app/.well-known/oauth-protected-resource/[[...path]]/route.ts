/**
 * Protected resource metadata (RFC 9728) for the MCP endpoint. Clients ask for it at
 * /.well-known/oauth-protected-resource/<resource path> (here /api/mcp/sse) and some at the bare
 * path, so both are answered with the same document.
 */

import type { NextRequest } from "next/server";
import { oauthPreflight, proxyOAuth } from "@/lib/api/oauth-proxy";

export const dynamic = "force-dynamic";

export const GET = (request: NextRequest) => proxyOAuth(request, "oauthMetadata", { doc: "protected-resource" });
export const OPTIONS = oauthPreflight;
