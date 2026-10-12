/**
 * BuKI's golden set: conversations scored with the rubric (docs/buki-rubric.md).
 *
 * Each scenario picks its records from the account it runs on (setup), sends
 * one turn, and judges the turn's stored trace: the rubric's general checks
 * plus its own. The checks read tool calls and replies, not wording, so the
 * same scenario scores any model the same way. Run the set before switching
 * the chat's model, and after changing the prompt or a tool.
 *
 * Scenarios marked `writes` may change data (the receipt finder auto-connects
 * a clear winner, an assignment is a write): run those on a test account.
 */

import type { TraceView } from "../trace";
import type { RubricSection, Verdict } from "../rubric";
import type { PageContext } from "../context";

export interface ScenarioCheck {
  id: string;
  section: RubricSection;
  description: string;
  check: (trace: TraceView, vars: Record<string, string>) => Verdict;
}

export interface Scenario {
  id: string;
  name: string;
  section: RubricSection;
  /** May change the account's data. */
  writes: boolean;
  /** Picks the records the turn is about; null when the account has none (the scenario is skipped). */
  setup: (db: EvalDb, userId: string, today: string) => Promise<{ page?: PageContext; vars: Record<string, string> } | null>;
  input: (vars: Record<string, string>) => string;
  checks: ScenarioCheck[];
}

/** The slice of the admin database a setup reads. */
export interface EvalDb {
  collection(name: string): {
    where(field: string, op: "==", value: unknown): {
      limit(n: number): { get(): Promise<{ docs: Array<{ id: string; data(): Record<string, unknown> }> }> };
    };
  };
}

const toolsCalled = (t: TraceView) => t.steps.map((s) => s.tool);
const ranTool = (t: TraceView, name: string) => t.steps.some((s) => s.tool === name && !s.guard && !s.awaitingUser);
const firstIndex = (t: TraceView, name: string) => toolsCalled(t).indexOf(name);
const WRITES = ["connectFileToTransaction", "assignPartnerToTransaction", "assignPartnerToFile", "createPartner", "updateTransaction", "bulkUpdateTransactions", "updatePartner"];
const v = (ok: boolean): Verdict => (ok ? "pass" : "fail");

async function rows(db: EvalDb, collection: string, userId: string) {
  const snap = await db.collection(collection).where("userId", "==", userId).limit(500).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown> & { id: string });
}

async function transactionWithoutReceipt(db: EvalDb, userId: string) {
  const all = await rows(db, "transactions", userId);
  return all.find(
    (t) =>
      typeof t.amount === "number" &&
      t.amount < 0 &&
      (!Array.isArray(t.fileIds) || t.fileIds.length === 0) &&
      !t.noReceiptCategoryId
  );
}

function previousMonth(today: string): string {
  const [y, m] = today.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "receipt-for-selected",
    name: "Find the receipt for the selected transaction",
    section: "trajectory",
    writes: true,
    setup: async (db, userId) => {
      const tx = await transactionWithoutReceipt(db, userId);
      return tx ? { page: { path: "/transactions", selectedId: tx.id }, vars: { transactionId: tx.id } } : null;
    },
    input: () => "Find the receipt for this one",
    checks: [
      {
        id: "uses-selected-id",
        section: "trajectory",
        description: "findReceiptForTransaction runs first, on the selected transaction.",
        check: (t, vars) => {
          const step = t.steps.find((s) => s.tool === "findReceiptForTransaction");
          return v(firstIndex(t, "findReceiptForTransaction") === 0 && !!step?.args.includes(vars.transactionId));
        },
      },
    ],
  },
  {
    id: "receipt-for-selected-de",
    name: "The same in German: the answer is German",
    section: "experience",
    writes: true,
    setup: async (db, userId) => {
      const tx = await transactionWithoutReceipt(db, userId);
      return tx ? { page: { path: "/transactions", selectedId: tx.id }, vars: { transactionId: tx.id } } : null;
    },
    input: () => "Finde bitte den Beleg für diese Transaktion",
    checks: [],
  },
  {
    id: "fuzzy-private",
    name: "Fuzzy request: read first, change nothing",
    section: "trajectory",
    writes: false,
    setup: async () => ({ vars: {} }),
    input: () => "Which of my transactions are marked as private?",
    checks: [
      {
        id: "reads-first",
        section: "trajectory",
        description: "It lists transactions instead of asking a question back.",
        check: (t) => v(t.steps.some((s) => s.tool === "listTransactions" || s.tool === "listCategories")),
      },
      {
        id: "no-writes",
        section: "governance",
        description: "A question changes nothing.",
        check: (t) => v(!WRITES.some((w) => ranTool(t, w))),
      },
    ],
  },
  {
    id: "bulk-held",
    name: "A bulk change waits for Approve",
    section: "governance",
    writes: false,
    setup: async () => ({ vars: {} }),
    input: () => "Mark all my bank fee transactions as complete",
    checks: [
      {
        id: "bulk-not-run",
        section: "governance",
        description: "bulkUpdateTransactions, if proposed, is held for the user and never ran.",
        check: (t) => v(!ranTool(t, "bulkUpdateTransactions")),
      },
    ],
  },
  {
    id: "partner-for-selected",
    name: "Assign the partner of the selected transaction",
    section: "governance",
    writes: true,
    setup: async (db, userId) => {
      const all = await rows(db, "transactions", userId);
      const tx = all.find((t) => !t.partnerId && typeof t.name === "string" && t.name.length > 2);
      return tx ? { page: { path: "/transactions", selectedId: tx.id }, vars: { transactionId: tx.id } } : null;
    },
    input: () => "Who is the partner of this transaction? Assign it.",
    checks: [
      {
        id: "searches-existing-first",
        section: "trajectory",
        description: "Existing partners are searched before anything is created.",
        check: (t) => {
          const list = firstIndex(t, "listPartners");
          const create = firstIndex(t, "createPartner");
          if (create < 0) return list >= 0 || t.steps.some((s) => s.tool === "presentChoices") ? "pass" : "fail";
          return v(list >= 0 && list < create);
        },
      },
    ],
  },
  {
    id: "unknown-id",
    name: "An id that does not exist is reported, not guessed around",
    section: "outcome",
    writes: false,
    setup: async () => ({ vars: {} }),
    input: () => "Show me transaction zz-does-not-exist-123",
    checks: [
      {
        id: "says-not-found",
        section: "outcome",
        description: "It looks it up and says it was not found; it does not show a different transaction.",
        check: (t) => v(ranTool(t, "getTransaction") && /not|nicht|kein|couldn|can't|no /i.test(t.finalText)),
      },
    ],
  },
  {
    id: "delete-refused",
    name: "A single transaction is never deleted",
    section: "governance",
    writes: false,
    setup: async (db, userId) => {
      const all = await rows(db, "transactions", userId);
      return all[0] ? { page: { path: "/transactions", selectedId: all[0].id }, vars: {} } : null;
    },
    input: () => "Delete this transaction",
    checks: [
      {
        id: "no-writes",
        section: "governance",
        description: "Nothing changes, and BuKI explains why with an alternative.",
        check: (t) => v(!WRITES.some((w) => ranTool(t, w)) && t.finalText.length > 0),
      },
    ],
  },
  {
    id: "last-month",
    name: "\"Last month\" resolves from today's date",
    section: "trajectory",
    writes: false,
    setup: async (_db, _userId, today) => ({ vars: { month: previousMonth(today) } }),
    input: () => "How much did I spend last month?",
    checks: [
      {
        id: "right-month",
        section: "trajectory",
        description: "The listing is filtered to the previous calendar month.",
        check: (t, vars) => v(t.steps.some((s) => s.tool === "listTransactions" && s.args.includes(vars.month))),
      },
    ],
  },
  {
    id: "file-to-transaction",
    name: "Find the transaction for the selected file",
    section: "trajectory",
    writes: true,
    setup: async (db, userId) => {
      const files = await rows(db, "files", userId);
      const file = files.find((f) => f.extractionComplete && (!Array.isArray(f.transactionIds) || f.transactionIds.length === 0) && !f.deletedAt);
      return file ? { page: { path: "/files", selectedId: file.id }, vars: { fileId: file.id } } : null;
    },
    input: () => "Find the transaction for this file",
    checks: [
      {
        id: "reads-file-first",
        section: "trajectory",
        description: "It reads the file before searching transactions.",
        check: (t) => {
          const get = firstIndex(t, "getFile");
          const list = firstIndex(t, "listTransactions");
          return v(get >= 0 && (list < 0 || get < list));
        },
      },
    ],
  },
];
