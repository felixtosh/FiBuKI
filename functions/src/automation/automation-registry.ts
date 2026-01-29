/**
 * Automation Registry
 *
 * Central registry that collects all automation metadata from Cloud Functions.
 * This is used by:
 * - Admin page (via getAutomationsCallable)
 * - MCP server (via build-time code generation)
 *
 * When adding a new automation:
 * 1. Add AUTOMATION_META export to your function file
 * 2. Import it here
 * 3. Add to AUTOMATION_REGISTRY
 */

import {
  AutomationMeta,
  AutomationGraph,
  AutomationCategory,
  isFirestoreTrigger,
} from "./types";

// =============================================================================
// IMPORTS - Add AUTOMATION_META imports here as they are created
// =============================================================================

// Matching triggers (files collection)
import { AUTOMATION_META as matchFilePartnerMeta } from "../matching/matchFilePartner";
import { AUTOMATION_META as matchFileTransactionsMeta } from "../matching/matchFileTransactions";

// Transaction triggers
import { AUTOMATION_META as onTransactionUpdateMeta } from "../matching/onTransactionUpdate";

// Partner triggers
import { AUTOMATION_META as onPartnerCreateMeta } from "../matching/onPartnerCreate";
import { AUTOMATION_META as onPartnerUpdateMeta } from "../matching/onPartnerUpdate";

// Category triggers
import { AUTOMATION_META as onCategoryCreateMeta } from "../matching/onCategoryCreate";
import { AUTOMATION_META as onCategoryUpdateMeta } from "../matching/onCategoryUpdate";

// =============================================================================
// REGISTRY
// =============================================================================

/**
 * All registered automations keyed by ID
 */
export const AUTOMATION_REGISTRY: Record<string, AutomationMeta> = {
  // File triggers
  matchFilePartner: matchFilePartnerMeta,
  matchFileTransactions: matchFileTransactionsMeta,

  // Transaction triggers
  onTransactionUpdate: onTransactionUpdateMeta,

  // Partner triggers
  onPartnerCreate: onPartnerCreateMeta,
  onPartnerUpdate: onPartnerUpdateMeta,

  // Category triggers
  onCategoryCreate: onCategoryCreateMeta,
  onCategoryUpdate: onCategoryUpdateMeta,
};

// =============================================================================
// QUERY FUNCTIONS
// =============================================================================

/**
 * Get all automations as array
 */
export function getAllAutomations(): AutomationMeta[] {
  return Object.values(AUTOMATION_REGISTRY);
}

/**
 * Get automation by ID
 */
export function getAutomation(id: string): AutomationMeta | undefined {
  return AUTOMATION_REGISTRY[id];
}

/**
 * Get automations by category
 */
export function getAutomationsByCategory(
  category: AutomationCategory
): AutomationMeta[] {
  return getAllAutomations().filter((a) => a.category === category);
}

/**
 * Get automations by trigger collection
 */
export function getAutomationsByCollection(collection: string): AutomationMeta[] {
  return getAllAutomations().filter((a) => {
    if (isFirestoreTrigger(a.trigger)) {
      return a.trigger.collection === collection;
    }
    return false;
  });
}

/**
 * Get all unique collections that have triggers
 */
export function getTriggerCollections(): string[] {
  const collections = new Set<string>();
  getAllAutomations().forEach((a) => {
    if (isFirestoreTrigger(a.trigger)) {
      collections.add(a.trigger.collection);
    }
  });
  return Array.from(collections).sort();
}

// =============================================================================
// GRAPH BUILDING
// =============================================================================

/**
 * Build dependency graph for visualization
 */
export function buildAutomationGraph(): AutomationGraph {
  const automations = getAllAutomations();

  const nodes = automations.map((a) => ({
    id: a.id,
    label: a.name,
    category: a.category,
    collection: isFirestoreTrigger(a.trigger) ? a.trigger.collection : undefined,
  }));

  const edges: AutomationGraph["edges"] = [];
  automations.forEach((a) => {
    if (a.chains) {
      a.chains.forEach((target) => {
        edges.push({ source: a.id, target });
      });
    }
  });

  return { nodes, edges };
}

/**
 * Validate that all chain references exist
 */
export function validateChainReferences(): {
  valid: boolean;
  errors: string[];
} {
  const allIds = new Set(Object.keys(AUTOMATION_REGISTRY));
  const errors: string[] = [];

  getAllAutomations().forEach((automation) => {
    if (automation.chains) {
      automation.chains.forEach((chainId) => {
        if (!allIds.has(chainId)) {
          errors.push(
            `Automation "${automation.id}" chains to unknown automation "${chainId}"`
          );
        }
      });
    }
  });

  return { valid: errors.length === 0, errors };
}
