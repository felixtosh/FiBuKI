/**
 * How BuKI hands a decision to the User (docs/buki-rubric.md, Governance).
 *
 * The escalation order:
 * 1. One clearly good answer: BuKI acts, no question asked.
 * 2. Several plausible answers: BuKI shows them with presentChoices. Each
 *    option can carry the write it stands for, which runs the moment the User
 *    clicks it, with "None of these" and a feedback field always beside them.
 * 3. Nothing good: BuKI says what would give it the context it lacks (connect
 *    a mailbox, use the browser extension, assign a few by hand), as options
 *    that open the right page.
 *
 * Separately, a few writes are big or hard to take back. Those never run
 * straight from the model: the tools node answers them with
 * `awaiting_confirmation`, the turn ends, and the write runs only when the
 * User approves it. That is enforced here and in the graph, not in the prompt.
 *
 * Both kinds of click come back as `choice` in the chat request, naming a
 * token the server issued with the proposal (lib/agent/pending-choice.ts), so
 * only what the agent proposed can run, once, for the User it was shown to.
 */

/**
 * Writes that wait for the User's yes: bulk changes, a rollback, a new bank
 * account. A single connect or Partner assignment does not: it is reversible
 * and the User wants it to feel like magic.
 */
export const TOOLS_REQUIRING_CONFIRMATION = ["bulkUpdateTransactions", "rollbackTransaction", "createSource"] as const;

export function requiresConfirmation(toolName: string): boolean {
  return (TOOLS_REQUIRING_CONFIRMATION as readonly string[]).includes(toolName);
}

/** The writes a presentChoices option may run when the User clicks it. */
export const CHOICE_ACTION_TOOLS = [
  "connectFileToTransaction",
  "assignPartnerToTransaction",
  "assignPartnerToFile",
  "createPartner",
  "updateTransaction",
  "bulkUpdateTransactions",
  "linkReceipt",
  "linkCorrection",
  "markFileAsCopy",
  "findReceiptForTransaction",
] as const;

export type ChoiceActionTool = (typeof CHOICE_ACTION_TOOLS)[number];

export function isChoiceActionTool(name: unknown): name is ChoiceActionTool {
  return typeof name === "string" && (CHOICE_ACTION_TOOLS as readonly string[]).includes(name);
}

/** The option id the card sends for "None of these". */
export const NONE_OPTION_ID = "none";

export interface ChoiceOption {
  id: string;
  label: string;
  detail?: string;
  action?: { tool: ChoiceActionTool; args: Record<string, unknown> };
  /** An app path the card opens (connect a mailbox, the browser extension page, a list). */
  navigate?: string;
}

/** What a presentChoices call answers, and what the card renders. */
export interface PresentedChoices {
  status: "awaiting_choice";
  question: string;
  options: ChoiceOption[];
  /** Issued by the tools node (lib/agent/pending-choice.ts); the card sends it back with the click. */
  token?: string;
}

/** What a confirmation tool answers instead of running. */
export interface AwaitingConfirmation {
  status: "awaiting_confirmation";
  tool: string;
  args: Record<string, unknown>;
  message: string;
  token: string;
}

export function awaitingConfirmation(tool: string, args: Record<string, unknown>, token: string): AwaitingConfirmation {
  return {
    status: "awaiting_confirmation",
    tool,
    args,
    message: "Not run: the user was shown Approve / Cancel for this change, and it runs only when they approve.",
    token,
  };
}

/** An internal app path: one leading slash, no scheme, no protocol-relative `//`. */
export function isAppPath(value: unknown): value is string {
  return typeof value === "string" && /^\/(?!\/)[\w\-/?=&.%]*$/.test(value) && value.length <= 200;
}

export interface ChoiceRequest {
  /** The token the tool result carried (lib/agent/pending-choice.ts). */
  token: string;
  optionId: string;
  feedback?: string;
}

/** The `choice` field of a chat request, or null when it is absent or malformed. */
export function parseChoiceRequest(raw: unknown): ChoiceRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.token !== "string" || !/^[0-9a-f]{64}$/.test(r.token)) return null;
  if (typeof r.optionId !== "string" || !r.optionId || r.optionId.length > 100) return null;
  const feedback = typeof r.feedback === "string" ? r.feedback.trim().slice(0, 1000) : undefined;
  return { token: r.token, optionId: r.optionId, ...(feedback ? { feedback } : {}) };
}

/** What the model reads when a click ran nothing. */
export function choiceNote(
  kind: "confirmation" | "choice",
  optionId: string,
  option: ChoiceOption | null,
  feedback?: string
): string {
  const said = feedback ? ` Their feedback: "${feedback}"` : "";
  if (kind === "confirmation") {
    return `[The user cancelled that change. Do not run it again unless they ask.${said}]`;
  }
  if (optionId === NONE_OPTION_ID || !option) {
    return (
      "[The user picked none of the options." +
      said +
      " Do not apply any of them. Use the feedback if there is some; otherwise ask what they expected, in one sentence.]"
    );
  }
  return `[The user chose "${option.label}"${option.detail ? ` (${option.detail})` : ""}.${said} Continue with it.]`;
}

/** What the model reads after a clicked write ran. */
export function actionNote(tool: string, label: string, result: unknown): string {
  let text = typeof result === "string" ? result : JSON.stringify(result);
  if (text.length > 4000) text = `${text.slice(0, 4000)}…`;
  const what = label === "approve" ? `approved ${tool}` : `chose "${label}"`;
  return (
    `[The user ${what}, and it has already run: ${tool} answered ${text}. ` +
    "Say in one short sentence what was done (or what failed). Do not run it again.]"
  );
}
