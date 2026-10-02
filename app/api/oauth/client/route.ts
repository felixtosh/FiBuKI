/** What the authorize page asks before it shows anything: is this request valid, and who is asking? */

import type { NextRequest } from "next/server";
import { proxyOAuth } from "@/lib/api/oauth-proxy";

export const dynamic = "force-dynamic";

export const GET = (request: NextRequest) => proxyOAuth(request, "oauthClientInfo");
