/**
 * presentChoices: BuKI hands a decision to the User as clickable options
 * (lib/agent/choices.ts has the escalation order and how a click resolves).
 *
 * The tool only validates and echoes the options; the card renders the echo,
 * and the turn ends after it. Option actions are passed as JSON text: every
 * provider accepts a string parameter, while a free-form object parameter is
 * refused by some (Gemini's function declarations among them).
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  CHOICE_ACTION_TOOLS,
  NONE_OPTION_ID,
  isAppPath,
  isChoiceActionTool,
  type ChoiceOption,
  type PresentedChoices,
} from "../choices";

const optionSchema = z.object({
  id: z.string().describe("Short unique id for this option, e.g. 'a', 'b'"),
  label: z.string().describe("What the user clicks, a few words: 'amazon_2026-03.pdf, 50.00 EUR'"),
  detail: z.string().optional().describe("One line of evidence: score, date, why it fits"),
  actionTool: z
    .enum(CHOICE_ACTION_TOOLS)
    .optional()
    .describe("The write that runs when the user clicks this option"),
  actionArgs: z
    .string()
    .optional()
    .describe('The arguments of actionTool as a JSON object, with ids copied exactly, e.g. {"fileId":"f1","transactionId":"t1"}'),
  navigate: z
    .string()
    .optional()
    .describe("Instead of an action: an app page to open, e.g. /integrations to connect a mailbox"),
});

export type PresentChoicesArgs = {
  question: string;
  options: Array<z.infer<typeof optionSchema>>;
};

/** The options as the card renders them, or an error the model can correct. */
export function presentChoices({ question, options }: PresentChoicesArgs): PresentedChoices | { error: string } {
  const out: ChoiceOption[] = [];
  const seen = new Set<string>();
  for (const o of options) {
    if (!o.id || o.id === NONE_OPTION_ID || seen.has(o.id)) {
      return { error: `Option ids must be unique and not "${NONE_OPTION_ID}" (the card adds "None of these" itself).` };
    }
    seen.add(o.id);
    const option: ChoiceOption = { id: o.id, label: o.label, ...(o.detail ? { detail: o.detail } : {}) };
    if (o.actionTool) {
      if (!isChoiceActionTool(o.actionTool)) return { error: `actionTool ${o.actionTool} cannot run from a choice.` };
      let args: unknown = {};
      try {
        args = o.actionArgs ? JSON.parse(o.actionArgs) : {};
      } catch {
        return { error: `Option ${o.id}: actionArgs is not valid JSON.` };
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return { error: `Option ${o.id}: actionArgs must be a JSON object.` };
      }
      option.action = { tool: o.actionTool, args: args as Record<string, unknown> };
    } else if (o.navigate) {
      if (!isAppPath(o.navigate)) return { error: `Option ${o.id}: navigate must be an app path like /integrations.` };
      option.navigate = o.navigate;
    }
    out.push(option);
  }
  return { status: "awaiting_choice", question, options: out };
}

export const presentChoicesTool = tool(async (args: PresentChoicesArgs) => presentChoices(args), {
  name: "presentChoices",
  description: `Show the user clickable options and end your turn. The card always adds "None of these" and a feedback field.

Use it when:
- there are 2-4 plausible answers and none clearly wins (receipt candidates, partner candidates): one option per candidate, with actionTool + actionArgs so a click runs the write directly;
- you found nothing good: options that give you the missing context, each with navigate (e.g. /integrations to connect a mailbox, /integrations for the browser extension, /transactions to assign a few by hand).

Do NOT use it when one answer is clearly right: act. Do not ask "should I?" with it. Put one short sentence before the call; the card is the end of your turn.`,
  schema: z.object({
    question: z.string().describe("One short line above the options"),
    options: z.array(optionSchema).min(1).max(5),
  }),
});

export const CHOICE_TOOLS = [presentChoicesTool];
