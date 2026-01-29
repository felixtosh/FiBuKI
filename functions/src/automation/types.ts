/**
 * Automation Metadata Types
 *
 * Defines the structure for automation metadata that is co-located
 * with Cloud Functions triggers and callables.
 *
 * This is the single source of truth for automation documentation.
 */

/**
 * Trigger types for Firestore-based automations
 */
export type FirestoreTriggerType =
  | "document_create"
  | "document_update"
  | "document_delete"
  | "callable"
  | "scheduled";

/**
 * Condition that must be met for trigger to fire
 */
export interface TriggerCondition {
  /** Field that changed */
  field: string;
  /** Expected before value (null = any/didn't exist) */
  from?: unknown;
  /** Expected after value */
  to: unknown;
}

/**
 * Entity types in the system
 */
export type EntityType =
  | "transaction"
  | "file"
  | "partner"
  | "noReceiptCategory"
  | "source"
  | "fileConnection"
  | "workerRequest"
  | "notification";

/**
 * Effect that an automation has on data
 */
export interface AutomationEffect {
  /** Entity type affected */
  entity: EntityType;
  /** Fields that may be modified */
  fields: string[];
  /** Type of modification */
  action: "create" | "update" | "delete";
}

/**
 * What this automation learns from successful operations
 */
export interface AutomationLearning {
  /** Entity that stores the learned data */
  entity: EntityType;
  /** Fields that get updated with learned patterns */
  fields: string[];
  /** Description of what is learned */
  description: string;
}

/**
 * Category for grouping automations
 */
export type AutomationCategory =
  | "matching"    // Partner, file, transaction matching
  | "learning"    // Pattern learning, resolution preference
  | "sync"        // Data synchronization (isComplete, etc.)
  | "search"      // Gmail search, receipt search
  | "cleanup";    // Scheduled cleanup tasks

/**
 * Firestore trigger configuration
 */
export interface FirestoreTrigger {
  type: "document_create" | "document_update" | "document_delete";
  /** Collection being watched */
  collection: string;
  /** Conditions for the trigger to execute logic */
  conditions?: TriggerCondition[];
}

/**
 * Callable function trigger configuration
 */
export interface CallableTrigger {
  type: "callable";
  /** Regions where deployed */
  regions?: string[];
}

/**
 * Scheduled trigger configuration
 */
export interface ScheduledTrigger {
  type: "scheduled";
  /** Cron expression or rate */
  schedule: string;
}

/**
 * Union of all trigger types
 */
export type AutomationTrigger = FirestoreTrigger | CallableTrigger | ScheduledTrigger;

/**
 * Metadata for an automation (trigger or callable)
 */
export interface AutomationMeta {
  /** Unique identifier matching the export name */
  id: string;

  /** Human-readable name */
  name: string;

  /** Brief description (1-2 sentences) */
  description: string;

  /** Trigger configuration */
  trigger: AutomationTrigger;

  /** What this automation modifies */
  effects: AutomationEffect[];

  /** What patterns this automation learns (optional) */
  learns?: AutomationLearning[];

  /** Configuration thresholds (optional) */
  config?: Record<string, number | string | boolean>;

  /** Other automations this chains to (optional) */
  chains?: string[];

  /** Icon name for UI display (optional) */
  icon?: string;

  /** Category for grouping */
  category: AutomationCategory;

  /** Whether this automation uses AI/LLM (e.g., Gemini, Claude) */
  aiPowered?: boolean;
}

/**
 * Graph representation for visualization
 */
export interface AutomationGraph {
  nodes: {
    id: string;
    label: string;
    category: AutomationCategory;
    collection?: string;
  }[];
  edges: {
    source: string;
    target: string;
  }[];
}

/**
 * Type guard for Firestore triggers
 */
export function isFirestoreTrigger(
  trigger: AutomationTrigger
): trigger is FirestoreTrigger {
  return (
    trigger.type === "document_create" ||
    trigger.type === "document_update" ||
    trigger.type === "document_delete"
  );
}

/**
 * Type guard for callable triggers
 */
export function isCallableTrigger(
  trigger: AutomationTrigger
): trigger is CallableTrigger {
  return trigger.type === "callable";
}

/**
 * Type guard for scheduled triggers
 */
export function isScheduledTrigger(
  trigger: AutomationTrigger
): trigger is ScheduledTrigger {
  return trigger.type === "scheduled";
}
