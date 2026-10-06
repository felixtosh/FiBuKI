/**
 * MCP tool annotations (spec 2025-06-18+).
 *
 * ChatGPT, Codex and Claude read these hints to decide when to ask the user
 * before a call. They are hints, never authorization: every handler still
 * checks the user itself.
 *
 * Each tool's class lives on its definition (`annotation`, required by the
 * type, #616), so a new tool cannot ship without one.
 */

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_DEFINITIONS, type ToolDefinition } from "../tools/definitions";

const byName = new Map<string, ToolDefinition>(TOOL_DEFINITIONS.map((def) => [def.name, def]));

/** "list_transactions_needing_files" -> "List transactions needing files" */
export function toolTitle(name: string): string {
  const words = name.split("_").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function annotationsFor(name: string): ToolAnnotations {
  const def = byName.get(name);
  const isReadOnly = def?.annotation === "read-only";
  return {
    title: toolTitle(name),
    readOnlyHint: isReadOnly,
    destructiveHint: def?.annotation === "destructive",
    openWorldHint: def?.openWorld === true,
  };
}
