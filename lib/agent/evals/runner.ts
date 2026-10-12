/**
 * Run BuKI's golden set (./scenarios) against the deployment's chat, as the
 * admin who started it, and score each turn's stored trace with the rubric.
 *
 * Each scenario is one real turn through /api/chat, so it measures exactly
 * what users get: the deployment's model, prompt, tools and guard. The result
 * keeps the shape the admin testing page renders.
 */

import { randomUUID } from "crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { scoreTrace, RUBRIC_CHECKS, type RubricSection } from "../rubric";
import { viennaToday } from "../context";
import type { TraceView } from "../trace";
import { SCENARIOS, type EvalDb, type Scenario } from "./scenarios";

export interface EvalCaseResult {
  testCase: { id: string; name: string; category: RubricSection; tags?: string[] };
  passed: boolean;
  duration: number;
  response?: string;
  toolsCalled?: string[];
  evaluation: {
    toolCallsCorrect: boolean;
    containsExpected: boolean;
    noUnexpectedContent: boolean;
    details: string[];
  };
  error?: string;
}

export interface EvalRunResult {
  runId: string;
  startedAt: Date;
  completedAt: Date;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  passRate: number;
  results: EvalCaseResult[];
}

export interface RunEvalsOptions {
  baseUrl: string;
  authToken: string;
  userId: string;
  /** Only the scenarios of one rubric section. */
  category?: RubricSection;
  /** Also run the scenarios that may change data (run those on a test account). */
  includeWrites?: boolean;
}

/** One turn through the chat route; resolves when the stream is fully read. */
async function sendTurn(options: RunEvalsOptions, scenario: Scenario, turnId: string, input: string, page?: unknown) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(`${options.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.authToken}` },
      body: JSON.stringify({
        messages: [{ id: `eval-${scenario.id}`, role: "user", content: input }],
        turnId,
        ...(page ? { page } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Chat API error: ${res.status}`);
    const reader = res.body?.getReader();
    while (reader) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    clearTimeout(timeout);
  }
}

/** The turn's trace, once the route has stored it. */
async function readTrace(userId: string, turnId: string): Promise<TraceView & { error?: string | null }> {
  const ref = getAdminDb().collection("chatTraces").doc(`${userId}_${turnId}`);
  for (let i = 0; i < 20; i++) {
    const snap = await ref.get();
    if (snap.exists) {
      const d = snap.data()!;
      return {
        userMessage: String(d.userMessage ?? ""),
        steps: Array.isArray(d.steps) ? d.steps : [],
        finalText: String(d.finalText ?? ""),
        hitStepLimit: !!d.hitStepLimit,
        error: d.error ?? null,
      };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("The turn stored no trace");
}

export async function runBukiEvals(options: RunEvalsOptions): Promise<EvalRunResult> {
  const startedAt = new Date();
  const today = viennaToday(startedAt).date;
  const db = getAdminDb() as unknown as EvalDb;
  const scenarios = SCENARIOS.filter(
    (s) => (!options.category || s.section === options.category) && (options.includeWrites || !s.writes)
  );
  const results: EvalCaseResult[] = [];

  for (const scenario of scenarios) {
    const began = Date.now();
    const testCase = { id: scenario.id, name: scenario.name, category: scenario.section, tags: scenario.writes ? ["writes"] : [] };
    const empty = { toolCallsCorrect: false, containsExpected: false, noUnexpectedContent: false, details: [] as string[] };
    try {
      const prepared = await scenario.setup(db, options.userId, today);
      if (!prepared) {
        results.push({ testCase, passed: true, duration: 0, evaluation: { ...empty, toolCallsCorrect: true, containsExpected: true, noUnexpectedContent: true, details: ["Skipped: this account has no record to run it on"] } });
        continue;
      }
      const turnId = randomUUID();
      await sendTurn(options, scenario, turnId, scenario.input(prepared.vars), prepared.page);
      const trace = await readTrace(options.userId, turnId);

      const general = scoreTrace(trace);
      const own = Object.fromEntries(scenario.checks.map((c) => [c.id, c.check(trace, prepared.vars)]));
      const describe = new Map([
        ...RUBRIC_CHECKS.map((c) => [c.id, c.description] as const),
        ...scenario.checks.map((c) => [c.id, c.description] as const),
      ]);
      const verdicts = Object.entries({ ...general, ...own }).filter(([, verdict]) => verdict !== "n/a");
      const failed = verdicts.filter(([, verdict]) => verdict === "fail");
      const sectionOk = (section: RubricSection) =>
        !failed.some(([id]) => (RUBRIC_CHECKS.find((c) => c.id === id)?.section ?? scenario.checks.find((c) => c.id === id)?.section) === section);

      results.push({
        testCase,
        passed: failed.length === 0 && !trace.error,
        duration: Date.now() - began,
        response: trace.finalText,
        toolsCalled: trace.steps.map((s) => (s.guard ? `${s.tool} (refused: ${s.guard})` : s.tool)),
        evaluation: {
          toolCallsCorrect: sectionOk("trajectory") && sectionOk("governance"),
          containsExpected: sectionOk("outcome"),
          noUnexpectedContent: sectionOk("experience"),
          details: [
            ...verdicts.map(([id, verdict]) => `${verdict === "pass" ? "✓" : "❌"} ${id}: ${describe.get(id) ?? ""}`),
            ...(trace.error ? [`❌ The turn failed: ${trace.error}`] : []),
          ],
        },
        ...(trace.error ? { error: trace.error } : {}),
      });
    } catch (error) {
      results.push({
        testCase,
        passed: false,
        duration: Date.now() - began,
        evaluation: { ...empty, details: [`❌ ${error instanceof Error ? error.message : String(error)}`] },
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const passedTests = results.filter((r) => r.passed).length;
  return {
    runId: `buki-eval-${startedAt.getTime()}`,
    startedAt,
    completedAt: new Date(),
    totalTests: results.length,
    passedTests,
    failedTests: results.length - passedTests,
    passRate: results.length ? passedTests / results.length : 0,
    results,
  };
}
