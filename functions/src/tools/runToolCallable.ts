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
 *
 * The caller is the chat agent, always (#665): this callable sets it, so the
 * few writes that record who made them record the agent (`ai`, Connection
 * Origin `agent`) and the agent's connect checks apply. Nothing in the
 * request can make a call the MCP caller or another caller, and nothing in
 * the arguments is read as the caller. The worker type, when one of the
 * agent's workers is running, comes from the web container's worker runtime
 * as its own field, outside the arguments, and only a known worker type is
 * taken. It unlocks nothing the User's session lacks: `receipt_search`
 * connects with stricter checks, and replacing automated File Connections is
 * open to the User through the connectFileToTransaction callable already.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import { handleTool } from "./handlers";
import { TOOL_NAMES } from "./definitions";
import { agentCaller, isAgentWorkerType } from "./caller";

export interface RunToolRequest {
  tool: string;
  arguments?: Record<string, unknown>;
  /** The agent worker making the call, if one is (types/worker.ts). */
  workerType?: string | null;
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
    const workerType = request?.workerType ?? null;
    if (workerType !== null && !isAgentWorkerType(workerType)) {
      throw new HttpsError("invalid-argument", "Unknown worker type");
    }
    try {
      return (await handleTool(ctx.userId, tool, args, agentCaller(workerType))) ?? null;
    } catch (err) {
      throw toolError(err);
    }
  }
);
