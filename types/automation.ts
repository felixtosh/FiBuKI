/**
 * Automation system types for transparency and MCP integration.
 * These types define the automation pipelines that help match
 * transactions to partners and files.
 */

/**
 * Supported integration types that automations can depend on
 */
export type IntegrationId = "gmail" | "outlook" | "browser" | null;

/**
 * Pipeline types for different automation flows
 */
export type PipelineId =
  | "find-partner"      // TX→Partner
  | "find-file"         // TX→File
  | "file-find-partner" // File→Partner
  | "file-find-tx"      // File→TX
  | "trigger-based";

/**
 * How an automation step is triggered within its pipeline
 */
export type AutomationTrigger =
  | "always"           // Always runs as part of the pipeline
  | "if_no_match"      // Only runs if previous steps didn't find a match
  | "if_integration"   // Only runs if required integration is connected
  | "on_partner_assign" // Runs when a partner is assigned to a file or transaction
  | "manual";          // Only runs when user explicitly triggers

/**
 * How a pipeline is triggered
 */
export type PipelineTrigger =
  | "on_import"           // When transactions are imported
  | "on_partner_create"   // When a new partner is created
  | "on_partner_update"   // When a partner's details change
  | "on_file_upload"      // When a file is uploaded
  | "on_extraction_complete" // When file extraction completes
  | "on_category_create"  // When a new no-receipt category is created
  | "on_transaction_update" // When a transaction is updated (e.g., partner assigned)
  | "chained"             // Runs after another pipeline completes
  | "manual";             // User manually triggers

/**
 * A single automation step within a pipeline
 */
export interface AutomationStep {
  /** Unique identifier for this step */
  id: string;

  /** Display name shown in the UI */
  name: string;

  /** Brief description of what this automation does */
  shortDescription: string;

  /** Detailed description for the detail panel */
  longDescription: string;

  /** Lucide icon name (e.g., "Building2", "Search", "Sparkles") */
  icon: string;

  /**
   * Integration this automation depends on.
   * null = system automation (always available)
   * "gmail" = requires Gmail integration
   * etc.
   */
  integrationId: IntegrationId;

  /** Transaction/file fields this automation can modify */
  affectedFields: string[];

  /**
   * Confidence range this automation produces.
   * For scoring-based systems, this represents the point contribution.
   */
  confidence?: {
    min: number;
    max: number;
    unit: "percent" | "points";
  };

  /** Execution order within the pipeline (lower = earlier) */
  order: number;

  /**
   * When this step runs within the pipeline.
   * - "always": Checked every time the pipeline runs
   * - "if_no_match": Only if previous steps didn't produce a match
   * - "if_integration": Only if required integration is connected
   * - "manual": Only when user explicitly triggers
   */
  trigger: AutomationTrigger;

  /** Whether this step can create new entities (e.g., new partners) */
  canCreateEntities?: boolean;

  /** Category for grouping in UI (e.g., "matching", "search", "ai") */
  category: "matching" | "search" | "ai" | "scoring";

  /** Where this automation is exposed/accessible */
  exposure: {
    /** UI pages where this automation is visible/actionable */
    ui: string[];
    /** Whether this automation is callable via MCP server tools */
    mcp: boolean;
    /** Whether this automation can be queried/explained via chat */
    chat: boolean;
  };
}

/**
 * A complete automation pipeline (collection of steps)
 */
export interface AutomationPipeline {
  /** Unique identifier for this pipeline */
  id: PipelineId;

  /** Display name for the pipeline */
  name: string;

  /** Description of what this pipeline accomplishes */
  description: string;

  /** Icon for the pipeline header */
  icon: string;

  /**
   * What events trigger this pipeline.
   * A pipeline can have multiple triggers.
   */
  triggers: {
    type: PipelineTrigger;
    description: string;
  }[];

  /** All steps in this pipeline, ordered by execution */
  steps: AutomationStep[];
}

/**
 * Status of an integration required by an automation
 */
export interface IntegrationStatus {
  integrationId: string;
  displayName: string;
  isConnected: boolean;
  needsReauth: boolean;
  isPaused?: boolean;
}

/**
 * Runtime status of an automation step
 */
export interface AutomationStepStatus {
  stepId: string;
  isAvailable: boolean;
  unavailableReason?: "integration_disconnected" | "integration_needs_reauth" | "integration_paused";
  integrationStatus?: IntegrationStatus;
}

/**
 * Result of explaining which automations applied to a transaction
 */
export interface TransactionAutomationExplanation {
  transactionId: string;

  /** Partner-related automation results */
  partnerAutomation?: {
    matchedBy?: string; // Step ID that made the match
    confidence?: number;
    isAutoApplied: boolean;
    suggestionsCount: number;
  };

  /** File-related automation results */
  fileAutomation?: {
    connectedFileIds: string[];
    autoMatchedCount: number;
    suggestionsCount: number;
  };

  /** Category-related automation results */
  categoryAutomation?: {
    matchedBy?: string;
    confidence?: number;
    isAutoApplied: boolean;
  };
}
