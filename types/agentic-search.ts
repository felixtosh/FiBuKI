/**
 * Agentic Precision Search Types
 *
 * Types for the agent-driven receipt search system where Claude
 * orchestrates searches, analyzes results, and decides what to download.
 */

import type { Timestamp } from "firebase/firestore";

/**
 * Email classification result from classifyEmail()
 */
export interface EmailClassification {
  hasPdfAttachment: boolean;
  possibleMailInvoice: boolean;
  possibleInvoiceLink: boolean;
  confidence: number;
  matchedKeywords?: string[];
}

/**
 * A candidate found during search that the agent can evaluate
 */
export interface AgentSearchCandidate {
  id: string;
  sourceType: "local_file" | "gmail_attachment" | "gmail_email";

  // Scoring
  score: number; // 0-100
  scoreLabel: "Strong" | "Likely" | null;
  scoreReasons: string[];

  // For local files
  fileId?: string;
  fileName?: string;
  extractedAmount?: number;
  extractedDate?: string;
  extractedPartner?: string;

  // For Gmail attachments/emails
  messageId?: string;
  attachmentId?: string;
  attachmentFilename?: string;
  attachmentMimeType?: string;
  attachmentSize?: number;
  emailSubject?: string;
  emailFrom?: string;
  emailDate?: string;
  emailSnippet?: string;
  integrationId?: string;
  integrationEmail?: string;

  // Whether this attachment was already downloaded
  alreadyDownloaded?: boolean;
  existingFileId?: string | null;

  // Email classification (for gmail_email type)
  classification?: EmailClassification;

  // Nomination tracking
  nominated?: boolean;
  nominatedAt?: Date;
  nominationReason?: string;
  downloadStatus?: "pending" | "downloading" | "completed" | "failed";
  downloadedFileId?: string;
}

/**
 * Results from one search operation
 */
export interface AgentSearchResults {
  searchId: string;
  searchType: "local_files" | "gmail_attachments" | "gmail_emails";
  strategy?: "partner_files" | "amount_files";
  query?: string;

  candidates: AgentSearchCandidate[];
  totalFound: number;
  searchedAt: Date;

  // Metadata
  integrationId?: string;
  integrationEmail?: string;
}

/**
 * State of an agentic search session
 * Stored in Firestore: agentSearchSessions/{sessionId}
 */
export interface AgentSearchSession {
  sessionId: string;
  transactionId: string;
  userId: string;

  // Transaction context (for display)
  transactionName: string;
  transactionAmount: number;
  transactionDate: Date;
  transactionPartner?: string;

  // Progress
  iteration: number; // Current loop (1-3)
  maxIterations: number; // Always 3

  // Accumulated results
  searchesPerformed: Array<{
    type: string;
    query?: string;
    strategy?: string;
    candidatesFound: number;
    at: Date;
  }>;

  // Nominations
  nominatedCandidates: AgentSearchCandidate[];

  // Outcomes
  filesConnected: string[];
  status: "active" | "completed" | "max_iterations_reached" | "user_cancelled";

  createdAt: Date;
  updatedAt: Date;
}

/**
 * Firestore version of AgentSearchSession (with Timestamps)
 */
export interface AgentSearchSessionDoc {
  sessionId: string;
  transactionId: string;
  userId: string;

  transactionName: string;
  transactionAmount: number;
  transactionDate: Timestamp;
  transactionPartner?: string;

  iteration: number;
  maxIterations: number;

  searchesPerformed: Array<{
    type: string;
    query?: string;
    strategy?: string;
    candidatesFound: number;
    at: Timestamp;
  }>;

  nominatedCandidates: AgentSearchCandidate[];
  filesConnected: string[];
  status: "active" | "completed" | "max_iterations_reached" | "user_cancelled";

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Input for searchLocalFiles tool
 */
export interface SearchLocalFilesInput {
  transactionId: string;
  strategy?: "partner_files" | "amount_files" | "both";
}

/**
 * Input for searchGmailAttachments tool
 */
export interface SearchGmailAttachmentsInput {
  transactionId: string;
  query?: string;
  integrationId?: string;
  maxResults?: number;
}

/**
 * Input for classifyEmails tool
 */
export interface ClassifyEmailsInput {
  messageIds: string[];
  integrationId: string;
  transactionId: string;
}

/**
 * Input for nominateForDownload tool
 */
export interface NominateForDownloadInput {
  transactionId: string;
  candidates: Array<{
    messageId: string;
    attachmentId: string;
    integrationId: string;
    reason: string;
  }>;
}

/**
 * Input for executeNominatedDownloads tool
 */
export interface ExecuteNominatedDownloadsInput {
  transactionId: string;
  autoConnect?: boolean;
}

/**
 * Input for convertEmailToPdf tool
 */
export interface ConvertEmailToPdfInput {
  messageId: string;
  integrationId: string;
  transactionId: string;
}
