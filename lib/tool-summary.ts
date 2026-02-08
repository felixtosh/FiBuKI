import { ToolCallSummary } from "@/types/notification";

/**
 * Tool name to human-readable label mapping
 * Merged superset of labels used by worker route and chat provider
 */
export const TOOL_LABELS: Record<string, string> = {
  searchLocalFiles: "Local files",
  searchGmailAttachments: "Gmail attachments",
  searchGmailMessages: "Gmail messages",
  connectFileToTransaction: "Connect file",
  downloadGmailAttachment: "Download attachment",
  assignPartnerToTransaction: "Assign partner",
  searchReceiptForTransaction: "Receipt search",
};

/** Tools to skip in summary (read-only / setup tools) */
export const SKIP_TOOLS = new Set([
  "getTransaction",
  "listFiles",
  "listTransactions",
  "getPartner",
  "listPartners",
]);

/** Action tools that count as "actions performed" */
const ACTION_TOOLS = new Set([
  "connectFileToTransaction",
  "downloadGmailAttachment",
  "assignPartnerToTransaction",
]);

/**
 * Check if a tool name is an action tool (as opposed to a search/read tool)
 */
export function isActionTool(toolName: string): boolean {
  return ACTION_TOOLS.has(toolName);
}

/**
 * Parse a tool call result into a structured summary.
 * Handles object results, string results, and missing results uniformly.
 */
export function parseToolResult(result: unknown): {
  outcome: string;
  status: ToolCallSummary["status"];
  resultCount?: number;
  confidence?: number;
} {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;

    // Check for error
    if (r.error) {
      return {
        status: "error",
        outcome: String(r.error).slice(0, 80),
      };
    }

    // Success/connected actions
    if (r.success === true || r.connected === true) {
      return {
        status: "success",
        outcome: r.fileName ? String(r.fileName) : "Done",
        confidence: typeof r.confidence === "number" ? r.confidence : undefined,
      };
    }

    // Array results
    if (r.results && Array.isArray(r.results)) {
      const count = r.results.length;
      return {
        resultCount: count,
        status: count > 0 ? "success" : "no_results",
        outcome: count > 0 ? `${count} result${count !== 1 ? "s" : ""}` : "0 results",
        confidence: typeof r.confidence === "number" ? r.confidence : undefined,
      };
    }

    if (r.files && Array.isArray(r.files)) {
      const count = r.files.length;
      return {
        resultCount: count,
        status: count > 0 ? "success" : "no_results",
        outcome: count > 0 ? `${count} result${count !== 1 ? "s" : ""}` : "0 results",
        confidence: typeof r.confidence === "number" ? r.confidence : undefined,
      };
    }

    if (r.totalResults !== undefined) {
      const count = Number(r.totalResults);
      return {
        resultCount: count,
        status: count > 0 ? "success" : "no_results",
        outcome: count > 0 ? `${count} result${count !== 1 ? "s" : ""}` : "0 results",
        confidence: typeof r.confidence === "number" ? r.confidence : undefined,
      };
    }

    // Partner name
    if (r.partnerName) {
      return {
        status: "success",
        outcome: String(r.partnerName),
        confidence: typeof r.confidence === "number" ? r.confidence : undefined,
      };
    }

    // Fallback for object results
    return {
      status: "no_results",
      outcome: "Done",
      confidence: typeof r.confidence === "number" ? r.confidence : undefined,
    };
  }

  // String results
  if (typeof result === "string") {
    const isError = result.toLowerCase().includes("error") || result.toLowerCase().includes("failed");
    return {
      status: isError ? "error" : "success",
      outcome: result.slice(0, 80),
    };
  }

  // No result / null / undefined
  return { status: "no_results", outcome: "" };
}

/**
 * Strip undefined values from a ToolCallSummary before writing to Firestore.
 * Explicitly constructs a new object, only including optional fields when defined.
 */
export function cleanToolSummary(
  label: string,
  parsed: ReturnType<typeof parseToolResult>
): ToolCallSummary {
  const summary: ToolCallSummary = {
    label,
    outcome: parsed.outcome,
    status: parsed.status,
  };
  if (parsed.resultCount !== undefined) {
    summary.resultCount = parsed.resultCount;
  }
  if (parsed.confidence !== undefined) {
    summary.confidence = parsed.confidence;
  }
  return summary;
}
