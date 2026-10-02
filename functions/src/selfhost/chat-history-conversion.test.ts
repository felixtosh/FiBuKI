/**
 * The chat's history as the agent reads it on the next turn.
 *
 * The chat's tools stream as AI SDK "dynamic-tool" parts. The converter used to
 * know only "tool-<name>" and "tool" parts, so it dropped every earlier tool
 * call and result: the model saw "Found 9 Revolut transactions" without a single
 * id, and on "yes" it invented ids, and the bulk update failed on all nine.
 */

import { describe, it, expect } from "vitest";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { convertToLangChainMessages } from "../../../lib/agent/ui-messages";

describe("chat history conversion", () => {
  it("keeps a dynamic tool call and its result, ids included", () => {
    const out = convertToLangChainMessages([
      { id: "u1", role: "user", parts: [{ type: "text", text: "find revolut" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "Looking…" },
          {
            type: "dynamic-tool",
            toolName: "listTransactions",
            toolCallId: "call_1",
            state: "output-available",
            input: { search: "revolut" },
            output: { transactions: [{ id: "HZYYXHD5JcOehlaFATrN" }] },
          },
          { type: "text", text: "Found 1." },
        ],
      },
      { id: "u2", role: "user", parts: [{ type: "text", text: "yes" }] },
    ]);

    expect(out.map((m) => m.getType())).toEqual(["human", "ai", "tool", "ai", "human"]);
    const call = out[1] as AIMessage;
    expect(call.tool_calls?.[0]).toMatchObject({
      id: "call_1",
      name: "listTransactions",
      args: { search: "revolut" },
    });
    const result = out[2] as ToolMessage;
    expect(result.tool_call_id).toBe("call_1");
    expect(String(result.content)).toContain("HZYYXHD5JcOehlaFATrN");
  });

  it("passes a failed tool call's error on to the model", () => {
    const out = convertToLangChainMessages([
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "bulkUpdateTransactions",
            toolCallId: "call_2",
            state: "output-error",
            input: { transactionIds: ["x"] },
            errorText: "Error: fetch failed",
          },
        ],
      },
    ]);
    expect(String((out[1] as ToolMessage).content)).toContain("fetch failed");
  });

  it("answers an interrupted tool call, so the model API accepts the history", () => {
    const out = convertToLangChainMessages([
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "bulkUpdateTransactions",
            toolCallId: "call_3",
            state: "input-available",
            input: { transactionIds: ["x"] },
          },
        ],
      },
    ]);
    expect(out.map((m) => m.getType())).toEqual(["ai", "tool"]);
    expect((out[1] as ToolMessage).tool_call_id).toBe("call_3");
  });
});
