export const dynamic = "force-dynamic";
/**
 * Chat API Route - Full LangGraph Implementation
 *
 * Uses LangGraph for agent orchestration with:
 * - @ai-sdk/langchain adapter for streaming
 * - LangFuse tracing, when its keys are set
 * - Vercel AI SDK compatible response format
 *
 * The request carries the session's messages, the page the User has open
 * (`page`), the turn's id (`turnId`, which names its trace) and, when the User
 * clicked a choice card, the click (`choice`, lib/agent/choices.ts). The model
 * is the deployment's (lib/agent/model.ts), never the browser's.
 */

import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { getAdminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import { randomUUID } from "crypto";

// Dynamic imports to avoid build-time analysis issues
const getAI = async () => import("ai");
const getLangchainAdapter = async () => import("@ai-sdk/langchain");
const getAgentGraph = async () => import("@/lib/agent/graph");
const getAgentModel = async () => import("@/lib/agent/model");
const getLangfuse = async () => import("@/lib/agent/langfuse");
const getUiMessages = async () => import("@/lib/agent/ui-messages");
const getUsageTracker = async () => import("@/lib/agent/usage-tracker");
const getTurnSupport = async () => {
  const [history, context, choices, runner, trace, rubric, tools, messages] = await Promise.all([
    import("@/lib/agent/history"),
    import("@/lib/agent/context"),
    import("@/lib/agent/choices"),
    import("@/lib/agent/choice-runner"),
    import("@/lib/agent/trace"),
    import("@/lib/agent/rubric"),
    import("@/lib/agent/tools"),
    import("@langchain/core/messages"),
  ]);
  return { history, context, choices, runner, trace, rubric, tools, messages };
};

const db = getAdminDb();

export const maxDuration = 60;

// Strip CR/LF so request-derived values cannot forge log lines
function sanitizeForLog(value: unknown): string {
  const raw = value instanceof Error ? value.stack || value.message : String(value);
  return raw.replace(/\n|\r/g, "");
}

/** The client's turn id when it is a plausible one; it names the trace, under the User's id. */
function turnIdFrom(raw: unknown): string {
  return typeof raw === "string" && /^[\w-]{8,64}$/.test(raw) ? raw : randomUUID();
}

function sessionIdFrom(raw: unknown): string | null {
  return typeof raw === "string" && /^[\w-]{1,128}$/.test(raw) ? raw : null;
}

// ============================================================================
// API Handler
// ============================================================================

export async function POST(req: Request) {
  const startedAt = Date.now();
  // Dynamic imports at runtime
  const { createUIMessageStreamResponse } = await getAI();
  const { toUIMessageStream } = await getLangchainAdapter();
  const { buildAgentGraph, RECURSION_LIMIT } = await getAgentGraph();
  const { getModelId, calculateCost, resolveChatProvider } = await getAgentModel();
  const { createLangfuseHandler, flushLangfuse } = await getLangfuse();
  const { history, context, choices, runner, trace, rubric, tools, messages: lc } = await getTurnSupport();

  const authHeader = req.headers.get("Authorization") || "";
  let userId: string;
  try {
    userId = await getServerUserIdWithFallback(req);
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    throw error;
  }
  const body = await req.json();
  const rawMessages = Array.isArray(body?.messages) ? body.messages : [];
  const turnId = turnIdFrom(body?.turnId);
  const sessionId = sessionIdFrom(body?.sessionId);
  const page = context.parsePageContext(body?.page);
  const choice = choices.parseChoiceRequest(body?.choice);
  const modelProvider = resolveChatProvider();

  console.log(`[Chat API] ${sanitizeForLog(modelProvider)}, ${sanitizeForLog(rawMessages.length)} messages${choice ? ", with a choice" : ""}`);

  // Convert messages to LangChain format. The agent graph owns the system
  // prompt (agentNode strips foreign SystemMessages and prepends its own).
  const { convertToLangChainMessages } = await getUiMessages();
  const messages = history.trimHistory(convertToLangChainMessages(rawMessages));

  // A click on a choice card runs what the server stored for it, then the
  // model reads what happened as part of the User's message.
  let choiceOutcome: Awaited<ReturnType<typeof runner.runChoice>> | null = null;
  if (choice) {
    choiceOutcome = await runner.runChoice({ userId, authHeader, choice, tools: tools.CHAT_TOOLS as never });
    const last = messages[messages.length - 1];
    if (last instanceof lc.HumanMessage) {
      messages[messages.length - 1] = new lc.HumanMessage(`${trace.textOf(last)}\n\n${choiceOutcome.note}`);
    } else {
      messages.push(new lc.HumanMessage(choiceOutcome.note));
    }
  }
  const lastHuman = [...messages].reverse().find((m) => m instanceof lc.HumanMessage);
  const userMessage = lastHuman ? trace.textOf(lastHuman) : "";

  // Create Langfuse handler for tracing
  const langfuseHandler = createLangfuseHandler({
    userId,
    metadata: {
      messageCount: messages.length,
    },
  });

  const graph = buildAgentGraph();

  // Token usage, counted when each model call ends (see lib/agent/usage-tracker.ts).
  const { createUsageTracker } = await getUsageTracker();
  const usage = createUsageTracker();

  // "values" carries the graph state after each step: the last one is the
  // turn's trace. Only "messages" goes on to the browser.
  const graphStream = await graph.stream(
    {
      messages,
      userId,
      authHeader,
      modelProvider,
      context: context.buildContextBlock({ now: new Date(), page }),
      toolRounds: 0,
      awaitingUser: false,
    },
    {
      streamMode: ["messages", "values"] as const,
      recursionLimit: RECURSION_LIMIT,
      callbacks: langfuseHandler ? [usage.handler, langfuseHandler] : [usage.handler],
    }
  );

  let finalState: { messages?: unknown[]; toolRounds?: number } | null = null;
  let streamError: string | null = null;

  async function* trackUsage(): AsyncGenerator<unknown> {
    // The try/catch is the point of this wrapper as much as the usage tracking is.
    //
    // Anything thrown while iterating the graph — a model call that fails, a tool
    // that rejects — happens AFTER the response headers are already on the wire,
    // so it cannot become an HTTP error. Without a handler the generator simply
    // stops: the client sees the assistant's opening sentence and then silence,
    // and the server logs NOTHING. Rethrowing preserves that behaviour for the
    // caller; the log and the trace's error are what make it diagnosable.
    try {
      for await (const chunk of graphStream) {
        if (Array.isArray(chunk) && chunk[0] === "values") {
          finalState = chunk[1] as typeof finalState;
          continue;
        }
        // Yield the FULL ["messages", [chunk, metadata]] tuple: toUIMessageStream
        // detects the langgraph format from it.
        yield chunk;
      }
    } catch (error) {
      streamError = error instanceof Error ? error.message : String(error);
      console.error(
        "[Chat API] Stream failed mid-response — the client will see a truncated answer with no error:",
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      throw error;
    }
  }

  const uiStream = toUIMessageStream(trackUsage() as never, {
    onFinal: async () => {
      const model = getModelId(modelProvider);
      const cost = calculateCost(modelProvider, usage.totals.input, usage.totals.output);

      if (userId && (usage.totals.input > 0 || usage.totals.output > 0)) {
        try {
          await db.collection("aiUsage").add({
            userId,
            function: "chat",
            model,
            inputTokens: usage.totals.input,
            outputTokens: usage.totals.output,
            estimatedCost: cost,
            createdAt: Timestamp.now(),
            metadata: null,
          });
        } catch (error) {
          console.error("[AI Usage] Failed to log usage:", error);
        }
      }

      // The turn's trace, scored with the rubric (docs/buki-rubric.md).
      try {
        const state = finalState as { messages?: unknown[]; toolRounds?: number } | null;
        const all = (state?.messages ?? []) as typeof messages;
        const { steps, finalText } = trace.traceSteps(all.slice(messages.length));
        const view = {
          userMessage,
          steps,
          finalText,
          hitStepLimit: (state?.toolRounds ?? 0) >= (await getAgentGraph()).MAX_TOOL_ROUNDS,
        };
        const verdicts = rubric.scoreTrace(view);
        await db
          .collection("chatTraces")
          .doc(`${userId}_${turnId}`)
          .set({
            userId,
            turnId,
            sessionId,
            createdAt: Timestamp.now(),
            durationMs: Date.now() - startedAt,
            provider: modelProvider,
            model,
            page: page ?? null,
            userMessage: userMessage.slice(0, 4000),
            choice: choice
              ? {
                  optionId: choice.optionId,
                  feedback: choice.feedback ?? null,
                  ran: choiceOutcome?.ran
                    ? { tool: choiceOutcome.ran.tool, result: JSON.stringify(choiceOutcome.ran.result ?? null).slice(0, 2000) }
                    : null,
                }
              : null,
            steps,
            finalText,
            toolRounds: state?.toolRounds ?? 0,
            hitStepLimit: view.hitStepLimit,
            inputTokens: usage.totals.input,
            outputTokens: usage.totals.output,
            estimatedCost: cost,
            error: streamError,
            verdicts,
            passRate: rubric.passRate(verdicts),
            feedback: null,
          });
      } catch (error) {
        console.error("[Chat API] Failed to store the trace:", error);
      }

      await flushLangfuse();
    },
  });

  return createUIMessageStreamResponse({ stream: uiStream });
}
