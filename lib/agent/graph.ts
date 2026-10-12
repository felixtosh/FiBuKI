/**
 * The sidebar chat's agent graph (LangGraph).
 *
 *   START -> agent -> (tool calls?) -> tools -> agent -> ... -> END
 *                                        \-> wrapUp -> END   (step budget spent)
 *
 * - agent: the model, with the static prompt plus the moment's context
 *   (lib/agent/context.ts).
 * - tools: runs the proposed calls, after the trajectory guard
 *   (lib/agent/trajectory-guard.ts) refused the senseless ones. A call to a
 *   write that needs the User's yes does not run: it is answered with
 *   `awaiting_confirmation` and a token. presentChoices runs and gets a token.
 *   Either ends the turn: the User's click continues it (lib/agent/choices.ts).
 * - wrapUp: after MAX_TOOL_ROUNDS the model answers in text from what it has,
 *   instead of the turn dying at the recursion limit mid-sentence.
 */

import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { RunnableConfig } from "@langchain/core/runnables";
import { CHAT_TOOLS } from "./tools";
import { SYSTEM_PROMPT } from "@/lib/chat/system-prompt";
import { createChatModel, ModelProvider } from "./model";
import { endedSilentlyAfterTools, SILENT_TURN_NUDGE } from "./silent-turn";
import { checkToolCalls } from "./trajectory-guard";
import { awaitingConfirmation, requiresConfirmation, type PresentedChoices } from "./choices";
import { issueChoice } from "./pending-choice";

/** Tool rounds per turn before the model must answer with what it has. */
export const MAX_TOOL_ROUNDS = 12;

/** LangGraph steps for that budget: agent + tools per round, the wrap-up, and slack. */
export const RECURSION_LIMIT = MAX_TOOL_ROUNDS * 2 + 6;

const WRAP_UP_NUDGE =
  "You have used this turn's tool budget. Do not call tools. Tell the user in two or three sentences what you " +
  "found and did so far, and what is still open.";

// ============================================================================
// State Definition
// ============================================================================

const AgentStateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
  userId: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "",
  }),
  authHeader: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "",
  }),
  modelProvider: Annotation<ModelProvider>({
    reducer: (_, next) => next,
    default: () => "gemini" as ModelProvider,
  }),
  /** The "Right now" block: date and open page. Also what an id may be grounded in. */
  context: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "",
  }),
  toolRounds: Annotation<number>({
    reducer: (_, next) => next,
    default: () => 0,
  }),
  /** Set when a round ended on a choice or a confirmation: the turn waits for the User. */
  awaitingUser: Annotation<boolean>({
    reducer: (_, next) => next,
    default: () => false,
  }),
});

type AgentState = typeof AgentStateAnnotation.State;

// ============================================================================
// Model Setup
// ============================================================================

const modelCache = new Map<string, Awaited<ReturnType<typeof createChatModel>>>();

/** The chat model; `answerOnly` may not call tools (the wrap-up). */
async function getModel(provider: ModelProvider, answerOnly = false) {
  const key = `${provider}:${answerOnly ? "answer" : "tools"}`;
  if (!modelCache.has(key)) {
    modelCache.set(
      key,
      await createChatModel({ provider, ...(answerOnly ? { toolChoice: "none" as const } : {}) }, CHAT_TOOLS)
    );
  }
  return modelCache.get(key)!;
}

function systemMessage(state: AgentState): SystemMessage {
  return new SystemMessage(state.context ? `${SYSTEM_PROMPT}\n\n${state.context}` : SYSTEM_PROMPT);
}

/** The graph owns the system prompt: any SystemMessage in state (client-injected or stale) is dropped. */
function withSystem(state: AgentState): BaseMessage[] {
  return [systemMessage(state), ...state.messages.filter((m) => !(m instanceof SystemMessage))];
}

function toolCallsOf(message: BaseMessage | undefined): Array<{ id?: string; name: string; args: Record<string, unknown> }> {
  const m = message as { tool_calls?: Array<{ id?: string; name: string; args: Record<string, unknown> }> } | undefined;
  return m?.tool_calls ?? [];
}

// ============================================================================
// Graph Nodes
// ============================================================================

async function agentNode(state: AgentState): Promise<Partial<AgentState>> {
  const { messages, userId, authHeader, modelProvider } = state;
  const model = await getModel(modelProvider);
  const input = withSystem(state);
  const config = { configurable: { userId, authHeader } };

  const response = await model.invoke(input, config);

  // Gemini sometimes ends a tool run with an empty turn: the tools ran, the
  // cards rendered, and the user is left with no word from BuKI. Ask once more
  // for the reply. The nudge is not kept in state, and the empty turn is dropped.
  if (endedSilentlyAfterTools(messages, response)) {
    console.warn("[Agent] Empty reply after tool results, asking for the reply");
    const retry = await model.invoke([...input, new HumanMessage(SILENT_TURN_NUDGE)], config);
    return { messages: [retry] };
  }
  return { messages: [response] };
}

const toolNode = new ToolNode(CHAT_TOOLS);

/**
 * Run one round of tool calls: refuse what the guard refuses, hold what needs
 * the User's yes, run the rest, and issue a token for each choice shown.
 */
async function toolsNode(state: AgentState, config?: RunnableConfig): Promise<Partial<AgentState>> {
  const { userId, authHeader } = state;
  const last = state.messages[state.messages.length - 1];
  const calls = toolCallsOf(last);
  const history = state.messages.slice(0, -1);

  const refusals = checkToolCalls(calls, history, state.context);
  const out: BaseMessage[] = [];
  const runnable: typeof calls = [];
  let awaitingUser = false;

  for (const [i, call] of calls.entries()) {
    const id = call.id ?? `#${i}`;
    const refusal = refusals.get(id);
    if (refusal) {
      console.warn(`[Tools] Guard refused ${call.name}: ${refusal.guard}`);
      out.push(new ToolMessage({ tool_call_id: id, name: call.name, content: JSON.stringify(refusal) }));
    } else if (requiresConfirmation(call.name)) {
      const token = await issueChoice(userId, {
        kind: "confirmation",
        toolCallId: id,
        options: [
          { id: "approve", label: "approve", action: { tool: call.name as never, args: call.args } },
          { id: "reject", label: "cancel" },
        ],
      });
      out.push(
        new ToolMessage({
          tool_call_id: id,
          name: call.name,
          content: JSON.stringify(awaitingConfirmation(call.name, call.args, token)),
        })
      );
      awaitingUser = true;
    } else {
      runnable.push(call);
    }
  }

  if (runnable.length > 0) {
    const toolConfig = {
      ...config,
      configurable: { ...config?.configurable, userId, authHeader },
    };
    const onlyRunnable = new AIMessage({ content: "", tool_calls: runnable.map((c, i) => ({ ...c, id: c.id ?? `#r${i}` })) });
    const result = (await toolNode.invoke({ messages: [...history, onlyRunnable] }, toolConfig)) as {
      messages: ToolMessage[];
    };
    for (const message of result.messages) {
      const call = runnable.find((c) => c.id === message.tool_call_id);
      if (call?.name === "presentChoices") {
        const shown = parseJson(message.content) as PresentedChoices | null;
        if (shown?.status === "awaiting_choice") {
          const token = await issueChoice(userId, { kind: "choice", toolCallId: message.tool_call_id, options: shown.options });
          out.push(
            new ToolMessage({
              tool_call_id: message.tool_call_id,
              name: "presentChoices",
              content: JSON.stringify({ ...shown, token }),
            })
          );
          awaitingUser = true;
          continue;
        }
      }
      out.push(message);
    }
  }

  // Keep the results in the order the model asked for them.
  const order = new Map(calls.map((c, i) => [c.id ?? `#${i}`, i]));
  out.sort((a, b) => (order.get((a as ToolMessage).tool_call_id) ?? 0) - (order.get((b as ToolMessage).tool_call_id) ?? 0));

  return { messages: out, toolRounds: state.toolRounds + 1, awaitingUser };
}

/** The step budget is spent: answer in text from what is known. */
async function wrapUpNode(state: AgentState): Promise<Partial<AgentState>> {
  const model = await getModel(state.modelProvider, true);
  const response = await model.invoke([...withSystem(state), new HumanMessage(WRAP_UP_NUDGE)]);
  return { messages: [response] };
}

function parseJson(content: unknown): unknown {
  if (typeof content !== "string") return content;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// ============================================================================
// Routing
// ============================================================================

function routeAfterAgent(state: AgentState): "tools" | typeof END {
  return toolCallsOf(state.messages[state.messages.length - 1]).length > 0 ? "tools" : END;
}

function routeAfterTools(state: AgentState): "agent" | "wrapUp" | typeof END {
  if (state.awaitingUser) return END;
  if (state.toolRounds >= MAX_TOOL_ROUNDS) return "wrapUp";
  return "agent";
}

// ============================================================================
// Graph Definition
// ============================================================================

export function buildAgentGraph() {
  return new StateGraph(AgentStateAnnotation)
    .addNode("agent", agentNode)
    .addNode("tools", toolsNode)
    .addNode("wrapUp", wrapUpNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", routeAfterAgent, { tools: "tools", [END]: END })
    .addConditionalEdges("tools", routeAfterTools, { agent: "agent", wrapUp: "wrapUp", [END]: END })
    .addEdge("wrapUp", END)
    .compile();
}

// Re-export for consumers
export type { ModelProvider };
