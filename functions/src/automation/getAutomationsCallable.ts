/**
 * Get Automations Callable
 *
 * Returns all registered automations and optionally the dependency graph.
 * Used by the admin page to display automation information.
 */

import { createCallable } from "../utils/createCallable";
import {
  getAllAutomations,
  buildAutomationGraph,
  getTriggerCollections,
  validateChainReferences,
} from "./automation-registry";
import { AutomationMeta, AutomationGraph } from "./types";

// =============================================================================
// REQUEST/RESPONSE TYPES
// =============================================================================

interface GetAutomationsRequest {
  /** Include the dependency graph for visualization */
  includeGraph?: boolean;
  /** Include validation errors */
  includeValidation?: boolean;
}

interface AutomationResponse {
  id: string;
  name: string;
  description: string;
  trigger: AutomationMeta["trigger"];
  effects: AutomationMeta["effects"];
  learns?: AutomationMeta["learns"];
  config?: AutomationMeta["config"];
  chains?: AutomationMeta["chains"];
  icon?: AutomationMeta["icon"];
  category: AutomationMeta["category"];
}

interface GetAutomationsResponse {
  automations: AutomationResponse[];
  collections: string[];
  graph?: AutomationGraph;
  validation?: {
    valid: boolean;
    errors: string[];
  };
}

// =============================================================================
// CALLABLE
// =============================================================================

export const getAutomationsCallable = createCallable<
  GetAutomationsRequest,
  GetAutomationsResponse
>(
  {
    name: "getAutomations",
    skipUsageLogging: true, // Don't log admin page reads
  },
  async (_ctx, request) => {
    const automations = getAllAutomations().map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      trigger: a.trigger,
      effects: a.effects,
      learns: a.learns,
      config: a.config,
      chains: a.chains,
      icon: a.icon,
      category: a.category,
    }));

    const collections = getTriggerCollections();

    const response: GetAutomationsResponse = {
      automations,
      collections,
    };

    if (request.includeGraph) {
      response.graph = buildAutomationGraph();
    }

    if (request.includeValidation) {
      response.validation = validateChainReferences();
    }

    return response;
  }
);
