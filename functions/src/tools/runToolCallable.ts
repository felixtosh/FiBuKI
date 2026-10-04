/**
 * Run one AI tool as the signed-in User (#616).
 *
 * The same handler MCP and the REST API run (handleTool), reached with the
 * User's login session instead of an API key, so the chat assistant's tools
 * with an MCP twin are thin wrappers over this and there is one
 * implementation of each. The plan feature gate applies, inside handleTool,
 * so a tool is the same feature on either surface. The API-key rate limit
 * does not: chat usage is already counted per AI call.
 *
 * The User is the session's, always. Nothing in the request names one: a
 * `userId` among the arguments is just an argument, and no handler reads one.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import { handleTool } from "./handlers";
import { TOOL_NAMES } from "./definitions";

export interface RunToolRequest {
  tool: string;
  arguments?: Record<string, unknown>;
}

const KNOWN_TOOLS = new Set(TOOL_NAMES);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A tool's failure as the callable reports it. The message is the one MCP
 * returns for the same call (a tool's errors are written for the caller);
 * the code only sorts it.
 */
export function toolError(err: unknown): HttpsError {
  if (err instanceof HttpsError) return err;
  const message = err instanceof Error && err.message ? err.message : "Tool failed";
  if (/not found/i.test(message)) return new HttpsError("not-found", message);
  if (/requires the .* feature/i.test(message)) return new HttpsError("permission-denied", message);
  return new HttpsError("failed-precondition", message);
}

export const runToolCallable = createCallable<RunToolRequest, unknown>(
  { name: "runTool", memory: "512MiB", timeoutSeconds: 120 },
  async (ctx, request) => {
    const tool = request?.tool;
    // The name is never echoed back: it is caller text.
    if (typeof tool !== "string" || !KNOWN_TOOLS.has(tool)) {
      throw new HttpsError("invalid-argument", "Unknown tool");
    }
    const args = request?.arguments ?? {};
    if (!isPlainObject(args)) {
      throw new HttpsError("invalid-argument", "arguments must be an object");
    }
    try {
      return (await handleTool(ctx.userId, tool, args)) ?? null;
    } catch (err) {
      throw toolError(err);
    }
  }
);
