/**
 * The BuKI rubric's automatic checks (docs/buki-rubric.md).
 *
 * Every chat turn is scored with these when its trace is stored, and the
 * golden set (lib/agent/evals) adds per-scenario checks on top. They are code,
 * not an LLM judge: they read the trace's tool calls and reply, so they give
 * the same verdict for every model, which is what makes a model switch a
 * measured decision.
 *
 * A check answers pass, fail, or n/a when the turn gave it nothing to judge.
 */

import type { TraceStep, TraceView } from "./trace";
import { TOOLS_REQUIRING_CONFIRMATION } from "./choices";

export type RubricSection = "outcome" | "trajectory" | "governance" | "experience";
export type Verdict = "pass" | "fail" | "n/a";

export interface RubricCheck {
  id: string;
  section: RubricSection;
  description: string;
  check: (trace: TraceView) => Verdict;
}

const WRITE_TOOLS = new Set([
  "connectFileToTransaction",
  "assignPartnerToTransaction",
  "assignPartnerToFile",
  "createPartner",
  "updatePartner",
  "updateTransaction",
  "bulkUpdateTransactions",
  "createSource",
  "rollbackTransaction",
  "markFileAsCopy",
  "unmarkFileAsCopy",
  "makeFileTheOriginal",
  "linkCorrection",
  "unlinkCorrection",
  "linkReceipt",
  "unlinkReceipt",
  "splitFile",
  "dismissSplitSuggestion",
  "matchTransactionPartners",
  "downloadGmailAttachment",
  "convertEmailToPdf",
]);

const ran = (s: TraceStep) => !s.guard && !s.awaitingUser;
const verdict = (ok: boolean): Verdict => (ok ? "pass" : "fail");

/** A rough language guess from common function words: enough to catch a reply in the data's language. */
export function looksGerman(text: string): boolean {
  const words = text.toLowerCase().match(/[a-zäöüß]+/g) ?? [];
  if (words.length < 3) return false;
  const de = new Set(["und", "der", "die", "das", "ich", "nicht", "ist", "für", "mit", "den", "ein", "eine", "auf", "von", "zu", "es", "habe", "hab", "wurde", "kein", "keine", "bitte", "diese", "dieser", "mir", "noch", "auch", "wie", "was"]);
  const en = new Set(["and", "the", "is", "for", "with", "this", "that", "not", "found", "have", "of", "to", "a", "an", "it", "no", "please", "your", "you", "what", "how", "here", "on"]);
  let d = 0;
  let e = 0;
  for (const w of words) {
    if (de.has(w)) d++;
    if (en.has(w)) e++;
  }
  return d > e;
}

export const RUBRIC_CHECKS: RubricCheck[] = [
  // Outcome
  {
    id: "outcome.writes-succeeded",
    section: "outcome",
    description: "Every write BuKI ran succeeded.",
    check: (t) => {
      const writes = t.steps.filter((s) => WRITE_TOOLS.has(s.tool) && ran(s));
      return writes.length === 0 ? "n/a" : verdict(writes.every((s) => !s.failed));
    },
  },
  // Trajectory
  {
    id: "trajectory.no-senseless-calls",
    section: "trajectory",
    description: "No call was refused by the trajectory guard (invented id, Partner not searched, extraction not read, a loop).",
    check: (t) => (t.steps.length === 0 ? "n/a" : verdict(t.steps.every((s) => !s.guard))),
  },
  {
    id: "trajectory.within-budget",
    section: "trajectory",
    description: "The turn finished inside its tool budget.",
    check: (t) => verdict(!t.hitStepLimit),
  },
  {
    id: "trajectory.receipt-workflow-first",
    section: "trajectory",
    description: "A receipt search starts with findReceiptForTransaction, not the search primitives.",
    check: (t) => {
      const primitives = ["searchLocalFiles", "searchGmailAttachments", "generateSearchSuggestions"];
      const first = t.steps.findIndex((s) => primitives.includes(s.tool));
      if (first < 0) return "n/a";
      if (/gmail|mail|inbox|postfach|datei|files?\b/i.test(t.userMessage)) return "n/a"; // the user named the source
      return verdict(t.steps.slice(0, first).some((s) => s.tool === "findReceiptForTransaction"));
    },
  },
  // Governance
  {
    id: "governance.gated-writes-held",
    section: "governance",
    description: "A bulk change, rollback or new bank account never ran without the user's approval.",
    check: (t) => {
      const gated = t.steps.filter((s) => (TOOLS_REQUIRING_CONFIRMATION as readonly string[]).includes(s.tool));
      return gated.length === 0 ? "n/a" : verdict(gated.every((s) => !ran(s)));
    },
  },
  {
    id: "governance.partner-verified",
    section: "governance",
    description: "A Partner is created only after listPartners and a company lookup.",
    check: (t) => {
      const at = t.steps.findIndex((s) => s.tool === "createPartner" && ran(s));
      if (at < 0) return "n/a";
      const before = t.steps.slice(0, at).filter(ran);
      return verdict(
        before.some((s) => s.tool === "listPartners") &&
          before.some((s) => s.tool === "lookupCompanyInfo" || s.tool === "validateVatId")
      );
    },
  },
  {
    id: "governance.ambiguity-offered-as-choice",
    section: "governance",
    description: "When the receipt finder needs review, BuKI acts on a clear winner or offers the candidates as a choice.",
    check: (t) => {
      const review = t.steps.some((s) => s.tool === "findReceiptForTransaction" && /"needs_review"/.test(s.result));
      if (!review) return "n/a";
      return verdict(t.steps.some((s) => s.tool === "presentChoices" || (s.tool === "connectFileToTransaction" && ran(s))));
    },
  },
  {
    id: "governance.dead-end-gives-next-steps",
    section: "governance",
    description: "When nothing was found, BuKI offers ways to give it the missing context.",
    check: (t) => {
      const nothing = t.steps.some((s) => s.tool === "findReceiptForTransaction" && /"no_match"/.test(s.result));
      if (!nothing) return "n/a";
      return verdict(t.steps.some((s) => s.tool === "presentChoices" && /"navigate"/.test(s.result)));
    },
  },
  // Experience
  {
    id: "experience.not-silent",
    section: "experience",
    description: "The turn ends with words or a choice card, never on a bare tool card.",
    check: (t) => verdict(t.finalText.length > 0 || t.steps.some((s) => s.awaitingUser)),
  },
  {
    id: "experience.short",
    section: "experience",
    description: "The reply is short: the cards carry the details.",
    check: (t) => (t.finalText ? verdict(t.finalText.length <= 700) : "n/a"),
  },
  {
    id: "experience.user-language",
    section: "experience",
    description: "BuKI answers in the language the user wrote in, not the data's.",
    check: (t) => {
      if (!t.finalText || t.userMessage.trim().split(/\s+/).length < 3) return "n/a";
      return verdict(looksGerman(t.userMessage) === looksGerman(t.finalText));
    },
  },
];

export type RubricVerdicts = Record<string, Verdict>;

/** Every check's verdict for one trace. */
export function scoreTrace(trace: TraceView, checks: RubricCheck[] = RUBRIC_CHECKS): RubricVerdicts {
  return Object.fromEntries(checks.map((c) => [c.id, c.check(trace)]));
}

/** Pass rate over the checks that applied, or null when none did. */
export function passRate(verdicts: RubricVerdicts): number | null {
  const judged = Object.values(verdicts).filter((v) => v !== "n/a");
  return judged.length === 0 ? null : judged.filter((v) => v === "pass").length / judged.length;
}
