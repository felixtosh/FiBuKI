import { describe, expect, it } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { endedSilentlyAfterTools } from "./silent-turn";

const afterTool = [
  new HumanMessage("find the receipt"),
  new AIMessage({ content: "", tool_calls: [{ id: "t1", name: "searchGmailEmails", args: {} }] }),
  new ToolMessage({ content: "{}", tool_call_id: "t1" }),
];

describe("endedSilentlyAfterTools", () => {
  it("flags an empty reply to tool results", () => {
    expect(endedSilentlyAfterTools(afterTool, new AIMessage(""))).toBe(true);
    expect(endedSilentlyAfterTools(afterTool, new AIMessage("  \n"))).toBe(true);
  });

  it("flags Gemini's part-array content that holds no text", () => {
    const parts = new AIMessage({ content: [{ type: "text", text: "" }] });
    expect(endedSilentlyAfterTools(afterTool, parts)).toBe(true);
  });

  it("accepts a reply with text, string or parts", () => {
    expect(endedSilentlyAfterTools(afterTool, new AIMessage("Found it!"))).toBe(false);
    const parts = new AIMessage({ content: [{ type: "text", text: "Found it!" }] });
    expect(endedSilentlyAfterTools(afterTool, parts)).toBe(false);
  });

  it("accepts another round of tool calls without text", () => {
    const more = new AIMessage({
      content: "",
      tool_calls: [{ id: "t2", name: "searchLocalFiles", args: {} }],
    });
    expect(endedSilentlyAfterTools(afterTool, more)).toBe(false);
  });

  it("ignores a turn that ran no tools", () => {
    expect(endedSilentlyAfterTools([new HumanMessage("hi")], new AIMessage(""))).toBe(false);
  });
});
