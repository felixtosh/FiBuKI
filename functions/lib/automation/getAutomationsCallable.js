"use strict";
/**
 * Get Automations Callable
 *
 * Returns all registered automations and optionally the dependency graph.
 * Used by the admin page to display automation information.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAutomationsCallable = void 0;
const createCallable_1 = require("../utils/createCallable");
const automation_registry_1 = require("./automation-registry");
// =============================================================================
// CALLABLE
// =============================================================================
exports.getAutomationsCallable = (0, createCallable_1.createCallable)({
    name: "getAutomations",
    skipUsageLogging: true, // Don't log admin page reads
}, async (_ctx, request) => {
    const automations = (0, automation_registry_1.getAllAutomations)().map((a) => ({
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
    const collections = (0, automation_registry_1.getTriggerCollections)();
    const response = {
        automations,
        collections,
    };
    if (request.includeGraph) {
        response.graph = (0, automation_registry_1.buildAutomationGraph)();
    }
    if (request.includeValidation) {
        response.validation = (0, automation_registry_1.validateChainReferences)();
    }
    return response;
});
//# sourceMappingURL=getAutomationsCallable.js.map