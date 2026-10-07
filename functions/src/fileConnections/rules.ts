/**
 * The Connection Origin and the rules that key on it (#612).
 *
 * A File Connection is made by a User's click, by someone they direct (an MCP
 * client, the chat agent), or by automation guessing on its own (auto-connect,
 * the AI pass of Partner matching). What a connect may do depends on which:
 * this table is the one place that says so. The writer reads it; nothing else
 * decides these rules.
 */

/**
 * Who made a File Connection.
 *
 * - `manual`: a User picked the pair in the app (a connect dialog, a drop, a
 *   Gmail import, a Split moving the bundle's Connections to its parts).
 * - `suggestion`: a User accepted a stored Match. The server reads its
 *   Confidence and Match Sources; the client sends none.
 * - `mcp`: an external client through the tool surface.
 * - `agent`: the chat agent.
 * - `auto`: the matcher connecting a Match above the auto threshold.
 * - `ai`: the AI pass of Partner matching.
 */
export type ConnectionOrigin = "manual" | "suggestion" | "mcp" | "agent" | "auto" | "ai";

export const CONNECTION_ORIGINS: readonly ConnectionOrigin[] = [
  "manual",
  "suggestion",
  "mcp",
  "agent",
  "auto",
  "ai",
];

export interface OriginRules {
  /**
   * A connect of a rejected pair. `lift`: the connect takes the Rejection back,
   * stamped as an undone one. `refuse`: the connect is refused. The agent lifts
   * only when it says it overrides (a human asked for that pair), and is
   * refused otherwise.
   */
  rejection: "lift" | "refuse";
  /** May connect to a Transaction over the plan's quota. Only a User's click in the app. */
  overQuota: boolean;
  /**
   * What the connect teaches the Partner. `directed`: email domain, file source
   * patterns and the billing cycle. `automated`: the email domain only, so
   * automation never trains on its own guesses.
   */
  learning: "directed" | "automated";
  /** The stored `connectionType`, which readers of the record filter on. */
  connectionType: string;
  /** The activity entry's actor. */
  actor: "manual" | "suggestion" | "auto" | "ai";
}

export const ORIGIN_RULES: Readonly<Record<ConnectionOrigin, OriginRules>> = {
  manual: { rejection: "lift", overQuota: true, learning: "directed", connectionType: "manual", actor: "manual" },
  suggestion: {
    rejection: "refuse",
    overQuota: true,
    learning: "directed",
    connectionType: "suggestion_accepted",
    actor: "suggestion",
  },
  // An AI client acting for the User: it learns like the User, and the log says AI did it (#752).
  mcp: { rejection: "refuse", overQuota: false, learning: "directed", connectionType: "api", actor: "ai" },
  agent: { rejection: "refuse", overQuota: false, learning: "directed", connectionType: "manual", actor: "ai" },
  auto: { rejection: "refuse", overQuota: false, learning: "automated", connectionType: "auto_matched", actor: "auto" },
  ai: { rejection: "refuse", overQuota: false, learning: "automated", connectionType: "ai_matched", actor: "ai" },
};

/**
 * The `connectionType` labels a caller may store instead of its origin's own.
 * A Gmail import is a manual connect that says how the File arrived; the agent
 * labels its bulk connects `auto_matched` so a later agent run may replace them.
 */
export const CONNECTION_TYPE_LABELS: Readonly<Partial<Record<ConnectionOrigin, readonly string[]>>> = {
  manual: ["manual", "gmail_import", "gmail_html_conversion"],
  agent: ["manual", "auto_matched"],
};

export function isConnectionOrigin(value: unknown): value is ConnectionOrigin {
  return typeof value === "string" && (CONNECTION_ORIGINS as readonly string[]).includes(value);
}

/** Whether this connect lifts a Rejection, refuses on it, given the agent's override. */
export function rejectionRule(origin: ConnectionOrigin, overrideRejection: boolean): "lift" | "refuse" {
  if (origin === "agent" && overrideRejection) return "lift";
  return ORIGIN_RULES[origin].rejection;
}

/** The record id of a pair: one record per pair, whoever writes it. */
export function connectionDocId(fileId: string, transactionId: string): string {
  return `${fileId}__${transactionId}`;
}
