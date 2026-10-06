/**
 * Who is calling a tool (#665).
 *
 * The same handler serves MCP, the REST API and the chat assistant. A few
 * writes record who made them (a Partner assignment's `partnerMatchedBy`, a
 * File Connection's Connection Origin) and the chat agent connects with checks
 * an external client does not get. The caller says which, and only the server
 * sets it:
 *
 * - `mcp`: an external client with an API key (MCP, the REST API). The
 *   default: handleTool called without a caller is this one.
 * - `agent`: the chat assistant or one of its workers, reached through the
 *   runTool callable, which sets it. The worker type, when a worker is
 *   running, decides the connect rules that differ per worker.
 *
 * Never read from a tool's arguments: a handler takes the caller as its own
 * parameter, and an argument named like it is just an argument.
 */

/**
 * The chat agent's worker types (types/worker.ts `WorkerType`, which this
 * package cannot import; the chat parity test holds the two lists equal).
 */
export const AGENT_WORKER_TYPES = [
  "file_matching",
  "partner_matching",
  "file_partner_matching",
  "receipt_search",
  "partner_file_batch",
] as const;

export type AgentWorkerType = (typeof AGENT_WORKER_TYPES)[number];

export type ToolCaller =
  | { kind: "mcp" }
  | { kind: "agent"; workerType: AgentWorkerType | null };

export const MCP_CALLER: ToolCaller = Object.freeze({ kind: "mcp" });

export function isAgentWorkerType(value: unknown): value is AgentWorkerType {
  return typeof value === "string" && (AGENT_WORKER_TYPES as readonly string[]).includes(value);
}

/** The chat agent, running as itself or as one worker. */
export function agentCaller(workerType: AgentWorkerType | null): ToolCaller {
  return Object.freeze({ kind: "agent", workerType });
}
