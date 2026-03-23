export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { VertexAI } from "@google-cloud/vertexai";

const GEMINI_MODEL = "gemini-2.0-flash-lite-001";
const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "taxstudio-f12fb";
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || "europe-west1";

interface PageSnapshot {
  url: string;
  title: string;
  buttons: { index: number; text: string; ariaLabel: string; tagName: string }[];
  links: { index: number; text: string; href: string }[];
  headings: string[];
  tables: number;
  visibleText: string;
  pageType?: "login" | "invoice_list" | "invoice_detail" | "download_area" | "overview_dashboard" | "unknown";
  pagination?: { hasAny: boolean; hasNext: boolean; hasPrevious: boolean; currentPage: number | null };
  invoiceLikeRows?: { index: number; amount: string; date: string; description: string; hasDownload: boolean }[];
}

interface TransactionInfo {
  amount: number;
  date: string | null;
  currency: string;
  partnerName: string;
}

interface AgentCommand {
  action: string;
  [key: string]: unknown;
}

interface AgentResponse {
  commands: AgentCommand[];
  reasoning: string;
  isDone: boolean;
  detectedInvoice?: { amount: string; date: string; downloadHint: string };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      pageSnapshot,
      currentUrl,
      transactionInfo,
      goal,
      previousActions,
      recipeHint,
      invoiceListMeta,
    } = body as {
      pageSnapshot: PageSnapshot;
      currentUrl: string;
      transactionInfo: TransactionInfo;
      goal: "navigate_to_invoices" | "find_invoice" | "download_invoice";
      previousActions?: AgentCommand[];
      recipeHint?: string[];
      invoiceListMeta?: {
        containerSelector?: string;
        selectionType?: string;
        sampleItems?: { text: string; date?: string; amount?: string }[];
        url?: string;
      };
    };

    if (!pageSnapshot || !transactionInfo) {
      return NextResponse.json({ error: "pageSnapshot and transactionInfo required" }, { status: 400 });
    }

    const vertexAI = new VertexAI({ project: PROJECT_ID, location: VERTEX_LOCATION });
    const model = vertexAI.getGenerativeModel({ model: GEMINI_MODEL });

    // Format amount for display
    const amountDisplay = (Math.abs(transactionInfo.amount) / 100).toFixed(2);
    const currency = transactionInfo.currency || "EUR";

    const prompt = buildPrompt({
      pageSnapshot,
      currentUrl: currentUrl || pageSnapshot.url,
      transactionInfo: {
        ...transactionInfo,
        amountDisplay: `${amountDisplay} ${currency}`,
      },
      goal,
      previousActions: previousActions || [],
      recipeHint: recipeHint || [],
      invoiceListMeta: invoiceListMeta || undefined,
    });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1024,
      },
    });

    const responseText = result.response?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // Parse JSON from response
    const parsed = parseAgentResponse(responseText);

    return NextResponse.json(parsed);
  } catch (err) {
    console.error("Replay agent error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Agent failed" },
      { status: 500 }
    );
  }
}

function buildPrompt(params: {
  pageSnapshot: PageSnapshot;
  currentUrl: string;
  transactionInfo: TransactionInfo & { amountDisplay: string };
  goal: string;
  previousActions: AgentCommand[];
  recipeHint: string[];
  invoiceListMeta?: {
    containerSelector?: string;
    selectionType?: string;
    sampleItems?: { text: string; date?: string; amount?: string }[];
    url?: string;
  };
}): string {
  const { pageSnapshot, currentUrl, transactionInfo, goal, previousActions, recipeHint, invoiceListMeta } = params;

  // Truncate visible text
  const visibleText = (pageSnapshot.visibleText || "").slice(0, 2000);

  // Format buttons and links for the prompt
  const buttonsStr = pageSnapshot.buttons
    .slice(0, 30)
    .map((b) => `  [${b.index}] "${b.text}" ${b.ariaLabel ? `(aria: "${b.ariaLabel}")` : ""} <${b.tagName}>`)
    .join("\n");

  const linksStr = pageSnapshot.links
    .slice(0, 30)
    .map((l) => `  [${l.index}] "${l.text}" → ${l.href}`)
    .join("\n");

  const headingsStr = pageSnapshot.headings.join(" > ");

  const previousActionsStr = previousActions.length > 0
    ? `\nPrevious actions tried:\n${JSON.stringify(previousActions, null, 2)}`
    : "";

  const recipeHintStr = recipeHint.length > 0
    ? `\nRecipe strategy hints:\n${recipeHint.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`
    : "";

  // Invoice list metadata from recording
  const invoiceListMetaStr = invoiceListMeta
    ? `\nINVOICE LIST METADATA (from recording):
  Container: ${invoiceListMeta.containerSelector || "unknown"}
  Selection type: ${invoiceListMeta.selectionType || "unknown"}
  Invoice list URL: ${invoiceListMeta.url || "unknown"}${
      invoiceListMeta.sampleItems && invoiceListMeta.sampleItems.length > 0
        ? `\n  Sample items from recording:\n${invoiceListMeta.sampleItems.map((item) =>
            `    - "${item.text}"${item.date ? ` (date: ${item.date})` : ""}${item.amount ? ` (amount: ${item.amount})` : ""}`
          ).join("\n")}`
        : ""
    }`
    : "";

  // Page type section
  const pageType = pageSnapshot.pageType || "unknown";
  const pageTypeStr = `\nPAGE TYPE: ${pageType}`;

  // Pagination section
  const pagination = pageSnapshot.pagination;
  const paginationStr = pagination?.hasAny
    ? `\nPAGINATION: ${[
        pagination.hasNext ? "Has Next" : null,
        pagination.hasPrevious ? "Has Previous" : null,
        pagination.currentPage != null ? `Page ${pagination.currentPage}` : null,
      ].filter(Boolean).join(", ")}`
    : "";

  // Invoice-like rows section
  const invoiceRows = pageSnapshot.invoiceLikeRows;
  const invoiceRowsStr = invoiceRows && invoiceRows.length > 0
    ? `\nDETECTED INVOICE ROWS:\n${invoiceRows.map((r) =>
        `  [${r.index}] Amount: ${r.amount || "?"} | Date: ${r.date || "?"} | ${r.description}${r.hasDownload ? " [HAS DOWNLOAD]" : ""}`
      ).join("\n")}`
    : "";

  // Page-type-specific instructions
  const pageTypeInstructions = getPageTypeInstructions(pageType);

  // Derive effective goal from page type
  const effectiveGoal = deriveGoal(goal, pageType);

  return `You are a browser automation agent helping download an invoice from a billing portal.

GOAL: ${effectiveGoal}
TRANSACTION: ${transactionInfo.partnerName} — ${transactionInfo.amountDisplay} on ${transactionInfo.date || "unknown date"}

CURRENT PAGE:
URL: ${currentUrl}
Title: ${pageSnapshot.title}
Headings: ${headingsStr}
Tables: ${pageSnapshot.tables}${pageTypeStr}${paginationStr}
${recipeHintStr}${invoiceListMetaStr}
${previousActionsStr}
${invoiceRowsStr}

INTERACTIVE ELEMENTS:
Buttons:
${buttonsStr || "  (none)"}

Links:
${linksStr || "  (none)"}

VISIBLE TEXT (truncated):
${visibleText}

INSTRUCTIONS:
${pageTypeInstructions}

RESPONSE FORMAT:
Return a JSON object with these fields:
- "commands": Array of actions to execute. Each action has:
  - "action": one of "navigate", "clickByText", "clickByAriaLabel", "clickBySelector", "type", "scrollTo", "wait", "capturePageAsPdf"
  - For "navigate": include "url" (string)
  - For "clickByText": include "text" (string) and optionally "tagName" (string)
  - For "clickByAriaLabel": include "label" (string)
  - For "clickBySelector": include "selector" (string)
  - For "type": include "selector" or "label" (string) and "value" (string)
  - For "scrollTo": include "y" (number)
  - For "wait": include "ms" (number)
  - For "capturePageAsPdf": no additional parameters needed. Captures the current page HTML and converts it to PDF. Use this when the invoice is displayed as an HTML page with no PDF download available.
- "reasoning": Brief explanation of your strategy (1-2 sentences)
- "isDone": true if you believe the invoice has been downloaded or the download was triggered
- "detectedInvoice": (optional) if you found the matching invoice row, include {"amount": "...", "date": "...", "downloadHint": "..."}

Keep commands list short (1-3 actions per turn).
Return ONLY the JSON object, no markdown, no explanation outside JSON.`;
}

function getPageTypeInstructions(pageType: string): string {
  switch (pageType) {
    case "login":
      return "This is a LOGIN page. Return empty commands with reasoning explaining auth is needed. The user must log in manually.";
    case "invoice_list":
      return "This is an INVOICE LIST page. Find the row matching the transaction amount and date from the DETECTED INVOICE ROWS above. Click its download button or navigate to its detail page.";
    case "invoice_detail":
      return "This is an INVOICE DETAIL page. Look for download/PDF buttons to download this invoice. If the amount doesn't match the target, go back to the invoice list. If NO download buttons or PDF links are found, the invoice may be an HTML page — use capturePageAsPdf to save it.";
    case "download_area":
      return "This is a DOWNLOAD AREA with multiple download links. Find and click the PDF download matching the target invoice.";
    case "overview_dashboard":
      return "This is a DASHBOARD or overview page. Navigate to the invoices/billing section. Look for links containing 'invoice', 'billing', 'Rechnung', 'Beleg', or similar.";
    default:
      return "Analyze the page to determine what actions will help find and download the target invoice. Look for navigation to invoices, download buttons, or PDF links.";
  }
}

function deriveGoal(originalGoal: string, pageType: string): string {
  switch (pageType) {
    case "login":
      return "wait_for_login";
    case "overview_dashboard":
      return "navigate_to_invoices";
    case "invoice_list":
      return "find_invoice";
    case "invoice_detail":
    case "download_area":
      return "download_invoice";
    default:
      return originalGoal;
  }
}

function parseAgentResponse(text: string): AgentResponse {
  // Try to extract JSON from the response
  const trimmed = text.trim();

  // Remove markdown code fences if present
  let jsonStr = trimmed;
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      commands: Array.isArray(parsed.commands) ? parsed.commands : [],
      reasoning: parsed.reasoning || "",
      isDone: parsed.isDone === true,
      detectedInvoice: parsed.detectedInvoice || undefined,
    };
  } catch {
    console.warn("Failed to parse agent response:", text.slice(0, 200));
    return {
      commands: [],
      reasoning: "Failed to parse LLM response",
      isDone: false,
    };
  }
}
