/**
 * MCP HTTP API
 *
 * Exposes MCP tools via HTTP with API key authentication.
 * This allows external tools (OpenClaw, Claude Desktop, ChatGPT) to access FiBuKI.
 */

import { onRequest } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { validateApiKey } from "../api-keys";
import { handleToolInternal } from "./handlers";
import { TOOL_DEFINITIONS } from "../tools/definitions";
import { PLANS } from "../billing/config";
import type { PlanId, RateLimitConfig } from "../billing/config";

const db = getFirestore();

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json",
};

interface McpRequest {
  tool: string;
  arguments: Record<string, unknown>;
}

// ============================================================================
// Rate Limiting (Firestore-based sliding window)
// ============================================================================

interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
}

async function checkRateLimit(userId: string, limits: RateLimitConfig): Promise<RateLimitResult> {
  const now = new Date();
  const minuteWindow = now.toISOString().slice(0, 16); // "2026-03-09T17:42"
  const hourWindow = now.toISOString().slice(0, 13);   // "2026-03-09T17"

  const docRef = db.collection("apiRateLimits").doc(userId);

  return db.runTransaction(async (tx) => {
    const doc = await tx.get(docRef);
    const data = doc.data() || {};

    // Reset counters when window changes
    let minuteCount = data.minuteWindow === minuteWindow ? (data.minuteCount || 0) : 0;
    let hourCount = data.hourWindow === hourWindow ? (data.hourCount || 0) : 0;

    // Check limits
    if (minuteCount >= limits.perMinute) {
      return { allowed: false, retryAfter: 60 };
    }
    if (hourCount >= limits.perHour) {
      return { allowed: false, retryAfter: 3600 };
    }

    // Increment counters
    minuteCount++;
    hourCount++;

    tx.set(docRef, {
      minuteCount,
      minuteWindow,
      hourCount,
      hourWindow,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { allowed: true };
  });
}

/**
 * Main MCP API endpoint (REST)
 *
 * POST /mcpApi
 * Headers: Authorization: Bearer fk_xxxxx
 * Body: { "tool": "list_transactions", "arguments": { "limit": 10 } }
 */
export const mcpApi = onRequest(
  {
    region: "europe-west1",
    memory: "512MiB",
    timeoutSeconds: 120,
  },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.set(CORS_HEADERS);
      res.status(204).send("");
      return;
    }

    res.set(CORS_HEADERS);

    if (req.method !== "POST") {
      res.status(405).json({ success: false, error: "Method not allowed" });
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ success: false, error: "Missing or invalid Authorization header" });
      return;
    }

    const apiKey = authHeader.substring(7);
    const validated = await validateApiKey(apiKey);
    if (!validated) {
      res.status(401).json({ success: false, error: "Invalid or expired API key" });
      return;
    }

    // Rate limiting
    const subDoc = await db.collection("subscriptions").doc(validated.userId).get();
    const planId: PlanId = (subDoc.exists ? subDoc.data()!.plan : "free") || "free";
    const plan = PLANS[planId] || PLANS.free;

    const rateLimitResult = await checkRateLimit(validated.userId, plan.rateLimit);
    if (!rateLimitResult.allowed) {
      res.set("Retry-After", String(rateLimitResult.retryAfter));
      res.status(429).json({
        success: false,
        error: `Rate limit exceeded. Retry after ${rateLimitResult.retryAfter} seconds.`,
        retryAfter: rateLimitResult.retryAfter,
      });
      return;
    }

    const body = req.body as McpRequest;
    if (!body.tool) {
      res.status(400).json({ success: false, error: "Missing 'tool' in request body" });
      return;
    }

    try {
      const result = await handleToolInternal(validated.userId, body.tool, body.arguments || {});
      res.status(200).json({ success: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[MCP API] Error in ${body.tool}:`, message);
      res.status(400).json({ success: false, error: message });
    }
  }
);

/**
 * List available tools
 */
export const mcpToolsList = onRequest({ region: "europe-west1" }, async (req, res) => {
  res.set(CORS_HEADERS);

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  res.status(200).json({
    tools: TOOL_DEFINITIONS,
  });
});

// Re-export MCP SSE endpoint
export { mcpSse } from "./mcp-sse";
