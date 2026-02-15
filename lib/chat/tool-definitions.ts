/**
 * AI Chat Tool Definitions
 *
 * This file defines the metadata for all chat tools available to the AI assistant.
 * It serves as documentation and can be used to generate UI for the admin panel.
 *
 * Tools are organized by category:
 * - Read: Fetch data without modifications
 * - Navigation: Control UI state
 * - Write: Modify data (require confirmation)
 * - Search: Find files/receipts
 * - Download: Fetch and save files (require confirmation)
 */

export type ToolCategory = "read" | "navigation" | "write" | "search" | "download";

export interface ChatToolDefinition {
  id: string;
  name: string;
  description: string;
  category: ToolCategory;
  requiresConfirmation: boolean;
  inputSchema: {
    required: string[];
    optional: string[];
  };
  outputFields: string[];
  relatedTools?: string[];
  examples?: string[];
}

// ============================================================================
// READ TOOLS (no confirmation)
// ============================================================================

export const READ_TOOLS: ChatToolDefinition[] = [
  {
    id: "listTransactions",
    name: "List Transactions",
    description:
      "List transactions with optional filters. Returns date, amount, partner, description, category, file status. Supports filtering by date range, amount range, search text, partner, and category.",
    category: "read",
    requiresConfirmation: false,
    inputSchema: {
      required: [],
      optional: [
        "startDate",
        "endDate",
        "search",
        "minAmount",
        "maxAmount",
        "sourceId",
        "partnerId",
        "categoryId",
        "hasFile",
        "limit",
      ],
    },
    outputFields: [
      "transactions[]",
      "total",
      "dateRange",
      "amountSum",
    ],
    examples: [
      "Show me my Amazon purchases from last month",
      "Find all transactions over 100 EUR",
      "What did I spend on groceries this year?",
    ],
  },
  {
    id: "getTransaction",
    name: "Get Transaction",
    description:
      "Get full details of a single transaction by ID. Returns all fields including metadata, partner info, files, and category.",
    category: "read",
    requiresConfirmation: false,
    inputSchema: {
      required: ["transactionId"],
      optional: [],
    },
    outputFields: [
      "id",
      "date",
      "amount",
      "name",
      "description",
      "partner",
      "partnerId",
      "fileIds",
      "categoryId",
      "sourceId",
      "metadata",
    ],
  },
  {
    id: "listSources",
    name: "List Sources",
    description:
      "List all bank accounts/sources. Returns account name, IBAN, currency, transaction count.",
    category: "read",
    requiresConfirmation: false,
    inputSchema: {
      required: [],
      optional: ["includeInactive"],
    },
    outputFields: [
      "sources[]",
      "total",
      "activeCount",
    ],
  },
  {
    id: "getSource",
    name: "Get Source",
    description:
      "Get details of a single bank account by ID. Returns full account information.",
    category: "read",
    requiresConfirmation: false,
    inputSchema: {
      required: ["sourceId"],
      optional: [],
    },
    outputFields: [
      "id",
      "name",
      "iban",
      "currency",
      "transactionCount",
      "lastSync",
    ],
  },
  {
    id: "getTransactionHistory",
    name: "Get Transaction History",
    description:
      "Get the edit history for a transaction. Shows all previous changes with timestamps and who made them.",
    category: "read",
    requiresConfirmation: false,
    inputSchema: {
      required: ["transactionId"],
      optional: [],
    },
    outputFields: [
      "history[]",
      "historyCount",
    ],
    relatedTools: ["rollbackTransaction"],
  },
  {
    id: "listFiles",
    name: "List Files",
    description:
      "List uploaded files with optional filters. Returns date, name, amount, partner, and connection status. Supports filtering by date range, amount range, search text, partner, and whether the file is connected to a transaction.",
    category: "read",
    requiresConfirmation: false,
    inputSchema: {
      required: [],
      optional: [
        "search",
        "partnerId",
        "startDate",
        "endDate",
        "minAmount",
        "maxAmount",
        "hasTransaction",
        "limit",
      ],
    },
    outputFields: [
      "files[]",
      "total",
      "hasMore",
    ],
    relatedTools: ["searchLocalFiles", "listTransactions"],
    examples: [
      "Show me all my uploaded files",
      "List invoices from IKEA",
      "Find files without transactions",
      "Show files from last month",
    ],
  },
  {
    id: "getQueueStatus",
    name: "Get Queue Status",
    description:
      "Get live background queue/load status. Shows whether Gmail import is running and how many files/transactions are queued for processing.",
    category: "read",
    requiresConfirmation: false,
    inputSchema: {
      required: [],
      optional: [],
    },
    outputFields: [
      "loadLevel",
      "isBusy",
      "summary",
      "gmailSync",
      "fileProcessing",
      "transactionProcessing",
      "workerQueue",
    ],
    examples: [
      "Is anything still processing right now?",
      "Why is matching taking so long?",
      "Check queue load before running bulk matching",
    ],
  },
];

// ============================================================================
// NAVIGATION TOOLS (no confirmation)
// ============================================================================

export const NAVIGATION_TOOLS: ChatToolDefinition[] = [
  {
    id: "navigateTo",
    name: "Navigate To",
    description:
      "Navigate to a page in the application. Supports /transactions and /sources pages.",
    category: "navigation",
    requiresConfirmation: false,
    inputSchema: {
      required: ["path"],
      optional: [],
    },
    outputFields: ["navigated"],
  },
  {
    id: "openTransactionSheet",
    name: "Open Transaction Sheet",
    description:
      "Open the detail sheet/sidebar for a specific transaction. Shows full transaction info with files and history.",
    category: "navigation",
    requiresConfirmation: false,
    inputSchema: {
      required: ["transactionId"],
      optional: [],
    },
    outputFields: ["opened"],
  },
  {
    id: "scrollToTransaction",
    name: "Scroll to Transaction",
    description:
      "Scroll to and highlight a transaction in the list. Helps users locate specific transactions visually.",
    category: "navigation",
    requiresConfirmation: false,
    inputSchema: {
      required: ["transactionId"],
      optional: [],
    },
    outputFields: ["scrolled"],
  },
];

// ============================================================================
// WRITE TOOLS (require confirmation)
// ============================================================================

export const WRITE_TOOLS: ChatToolDefinition[] = [
  {
    id: "updateTransaction",
    name: "Update Transaction",
    description:
      "Update a transaction's description or completion status. Creates history entry. REQUIRES USER CONFIRMATION.",
    category: "write",
    requiresConfirmation: true,
    inputSchema: {
      required: ["transactionId"],
      optional: ["description", "isComplete"],
    },
    outputFields: [
      "success",
      "transaction",
      "historyId",
    ],
    relatedTools: ["getTransaction", "rollbackTransaction"],
  },
  {
    id: "createSource",
    name: "Create Source",
    description:
      "Create a new bank account/source. REQUIRES USER CONFIRMATION.",
    category: "write",
    requiresConfirmation: true,
    inputSchema: {
      required: ["name", "iban"],
      optional: ["currency"],
    },
    outputFields: [
      "success",
      "sourceId",
    ],
  },
  {
    id: "rollbackTransaction",
    name: "Rollback Transaction",
    description:
      "Rollback a transaction to a previous state from its history. REQUIRES USER CONFIRMATION.",
    category: "write",
    requiresConfirmation: true,
    inputSchema: {
      required: ["transactionId", "historyId"],
      optional: [],
    },
    outputFields: [
      "success",
      "transaction",
    ],
    relatedTools: ["getTransactionHistory"],
  },
  {
    id: "matchTransactionPartners",
    name: "Match Transaction Partners",
    description:
      "Run partner matching for selected transactions (or all unassigned). Returns how many were already matched, processed, auto-matched, or left as suggestions.",
    category: "write",
    requiresConfirmation: false,
    inputSchema: {
      required: [],
      optional: ["transactionIds", "matchAllUnassigned"],
    },
    outputFields: [
      "scope",
      "requestedCount",
      "alreadyMatchedCount",
      "processed",
      "autoMatched",
      "withSuggestions",
      "unchangedCount",
    ],
    relatedTools: ["listTransactions", "getQueueStatus"],
    examples: [
      "Match partners for these 20 transactions",
      "Run partner matching for all unmatched transactions",
      "Match partners in this date range after selecting IDs",
    ],
  },
];

// ============================================================================
// SEARCH TOOLS (no confirmation)
// ============================================================================

export const SEARCH_TOOLS: ChatToolDefinition[] = [
  {
    id: "searchLocalFiles",
    name: "Search Local Files for Transaction",
    description:
      "Search uploaded files that might match a specific transaction. Requires a transaction ID. Scores files by amount, date, and partner match. Returns candidates with match scores and reasons.",
    category: "search",
    requiresConfirmation: false,
    inputSchema: {
      required: ["transactionId"],
      optional: ["strategy"],
    },
    outputFields: [
      "searchType",
      "strategy",
      "searchedTransaction",
      "summary",
      "candidates[]",
      "totalFound",
    ],
    relatedTools: ["listFiles", "searchGmailAttachments", "executeNominatedDownloads"],
    examples: [
      "Find receipts for this transaction",
      "Search for matching invoices for transaction X",
    ],
  },
  {
    id: "searchGmailAttachments",
    name: "Search Gmail Attachments",
    description:
      "Search Gmail for email attachments that might be receipts for a transaction. Scores and classifies results (PDF attachment, mail invoice, or invoice link). Does NOT download - returns candidates for review.",
    category: "search",
    requiresConfirmation: false,
    inputSchema: {
      required: ["transactionId"],
      optional: ["query"],
    },
    outputFields: [
      "searchType",
      "searchedTransaction",
      "queriesUsed",
      "summary",
      "candidates[]",
      "totalFound",
      "integrationCount",
    ],
    relatedTools: ["searchLocalFiles", "nominateForDownload", "executeNominatedDownloads"],
    examples: [
      "Search Gmail for Netflix invoice",
      "Find receipt in email for this transaction",
    ],
  },
  {
    id: "nominateForDownload",
    name: "Nominate for Download",
    description:
      "Mark Gmail attachments for download. Records selection but does NOT download immediately. After nominating, call executeNominatedDownloads to perform the actual download.",
    category: "search",
    requiresConfirmation: false,
    inputSchema: {
      required: ["transactionId", "candidates"],
      optional: [],
    },
    outputFields: [
      "success",
      "nominated",
      "candidates",
      "nextStep",
      "message",
    ],
    relatedTools: ["searchGmailAttachments", "executeNominatedDownloads"],
  },
  {
    id: "searchGmailEmails",
    name: "Search Gmail Emails",
    description:
      "Search Gmail for emails matching a query. Use this to find emails that might contain invoices in the body or have invoice download links. Returns emails with classification (mail invoice, invoice link, has attachments). Good for finding order confirmations, booking receipts, or emails with 'download invoice' links.",
    category: "search",
    requiresConfirmation: false,
    inputSchema: {
      required: ["query"],
      optional: ["transactionId", "dateFrom", "dateTo", "from", "limit"],
    },
    outputFields: [
      "searchType",
      "query",
      "emails[]",
      "totalFound",
      "integrationCount",
    ],
    relatedTools: ["analyzeEmail", "searchGmailAttachments", "convertEmailToPdf"],
    examples: [
      "Search Gmail for 'Netflix receipt'",
      "Find emails from amazon.de",
      "Search for booking confirmation emails",
    ],
  },
  {
    id: "analyzeEmail",
    name: "Analyze Email for Invoice",
    description:
      "Use AI to deeply analyze an email's content. Determines: (1) if the email body IS an invoice/receipt, (2) if it contains links to download an invoice. Returns extracted invoice URLs and confidence scores. Use when keyword classification shows 'possibleInvoiceLink' or when you need to verify if an email is a valid invoice.",
    category: "search",
    requiresConfirmation: false,
    inputSchema: {
      required: ["integrationId", "messageId"],
      optional: ["transactionId"],
    },
    outputFields: [
      "messageId",
      "subject",
      "from",
      "hasInvoiceLink",
      "invoiceLinks[]",
      "isMailInvoice",
      "mailInvoiceConfidence",
      "reasoning",
    ],
    relatedTools: ["searchGmailEmails", "convertEmailToPdf", "executeNominatedDownloads"],
    examples: [
      "Analyze this email to find invoice download links",
      "Check if this email body is an invoice",
    ],
  },
];

// ============================================================================
// DOWNLOAD TOOLS (require confirmation)
// ============================================================================

export const DOWNLOAD_TOOLS: ChatToolDefinition[] = [
  {
    id: "executeNominatedDownloads",
    name: "Execute Nominated Downloads",
    description:
      "Download nominated Gmail attachments and connect them to a transaction. Performs actual download after nomination. REQUIRES USER CONFIRMATION.",
    category: "download",
    requiresConfirmation: true,
    inputSchema: {
      required: ["transactionId", "candidates"],
      optional: [],
    },
    outputFields: [
      "success",
      "downloaded",
      "failed",
      "results[]",
      "message",
    ],
    relatedTools: ["nominateForDownload", "searchGmailAttachments"],
    examples: [
      "Download the Netflix invoice from Gmail",
      "Save this attachment as receipt",
    ],
  },
  {
    id: "convertEmailToPdf",
    name: "Convert Email to PDF",
    description:
      "Convert an email body to PDF and save as receipt. Use when the email itself is the invoice (no PDF attachment), like booking confirmations or order receipts. REQUIRES USER CONFIRMATION.",
    category: "download",
    requiresConfirmation: true,
    inputSchema: {
      required: ["transactionId", "integrationId", "messageId"],
      optional: ["emailSubject", "emailFrom"],
    },
    outputFields: [
      "success",
      "fileId",
      "fileName",
      "downloadUrl",
      "message",
    ],
    relatedTools: ["searchGmailAttachments"],
    examples: [
      "Convert this booking confirmation email to PDF",
      "Save the email as an invoice",
    ],
  },
];

// ============================================================================
// ALL TOOLS
// ============================================================================

export const ALL_CHAT_TOOLS: ChatToolDefinition[] = [
  ...READ_TOOLS,
  ...NAVIGATION_TOOLS,
  ...WRITE_TOOLS,
  ...SEARCH_TOOLS,
  ...DOWNLOAD_TOOLS,
];

// Helper to get tool by ID
export function getChatToolById(id: string): ChatToolDefinition | undefined {
  return ALL_CHAT_TOOLS.find((t) => t.id === id);
}

// Helper to get tools by category
export function getChatToolsByCategory(category: ToolCategory): ChatToolDefinition[] {
  return ALL_CHAT_TOOLS.filter((t) => t.category === category);
}

// Category metadata for UI display
export const TOOL_CATEGORIES: Record<ToolCategory, { name: string; description: string; icon: string }> = {
  read: {
    name: "Read Operations",
    description: "Fetch data without making changes",
    icon: "Search",
  },
  navigation: {
    name: "Navigation",
    description: "Control UI state and navigation",
    icon: "Monitor",
  },
  write: {
    name: "Write Operations",
    description: "Modify data (requires confirmation)",
    icon: "Edit",
  },
  search: {
    name: "Search",
    description: "Find files and receipts across sources",
    icon: "FileSearch",
  },
  download: {
    name: "Download",
    description: "Download and save files (requires confirmation)",
    icon: "Download",
  },
};
