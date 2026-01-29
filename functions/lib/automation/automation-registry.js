"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AUTOMATION_REGISTRY = void 0;
exports.getAllAutomations = getAllAutomations;
exports.getAutomation = getAutomation;
exports.getAutomationsByCategory = getAutomationsByCategory;
exports.getAutomationsByCollection = getAutomationsByCollection;
exports.getTriggerCollections = getTriggerCollections;
exports.buildAutomationGraph = buildAutomationGraph;
exports.validateChainReferences = validateChainReferences;
const types_1 = require("./types");
// =============================================================================
// IMPORTS - Add AUTOMATION_META imports here as they are created
// =============================================================================
// Matching triggers (files collection)
const matchFilePartner_1 = require("../matching/matchFilePartner");
const matchFileTransactions_1 = require("../matching/matchFileTransactions");
// Transaction triggers
const onTransactionUpdate_1 = require("../matching/onTransactionUpdate");
// Partner triggers
const onPartnerCreate_1 = require("../matching/onPartnerCreate");
const onPartnerUpdate_1 = require("../matching/onPartnerUpdate");
// Category triggers
const onCategoryCreate_1 = require("../matching/onCategoryCreate");
const onCategoryUpdate_1 = require("../matching/onCategoryUpdate");
// =============================================================================
// REGISTRY
// =============================================================================
/**
 * All registered automations keyed by ID
 */
exports.AUTOMATION_REGISTRY = {
    // File triggers
    matchFilePartner: matchFilePartner_1.AUTOMATION_META,
    matchFileTransactions: matchFileTransactions_1.AUTOMATION_META,
    // Transaction triggers
    onTransactionUpdate: onTransactionUpdate_1.AUTOMATION_META,
    // Partner triggers
    onPartnerCreate: onPartnerCreate_1.AUTOMATION_META,
    onPartnerUpdate: onPartnerUpdate_1.AUTOMATION_META,
    // Category triggers
    onCategoryCreate: onCategoryCreate_1.AUTOMATION_META,
    onCategoryUpdate: onCategoryUpdate_1.AUTOMATION_META,
};
// =============================================================================
// QUERY FUNCTIONS
// =============================================================================
/**
 * Get all automations as array
 */
function getAllAutomations() {
    return Object.values(exports.AUTOMATION_REGISTRY);
}
/**
 * Get automation by ID
 */
function getAutomation(id) {
    return exports.AUTOMATION_REGISTRY[id];
}
/**
 * Get automations by category
 */
function getAutomationsByCategory(category) {
    return getAllAutomations().filter((a) => a.category === category);
}
/**
 * Get automations by trigger collection
 */
function getAutomationsByCollection(collection) {
    return getAllAutomations().filter((a) => {
        if ((0, types_1.isFirestoreTrigger)(a.trigger)) {
            return a.trigger.collection === collection;
        }
        return false;
    });
}
/**
 * Get all unique collections that have triggers
 */
function getTriggerCollections() {
    const collections = new Set();
    getAllAutomations().forEach((a) => {
        if ((0, types_1.isFirestoreTrigger)(a.trigger)) {
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
function buildAutomationGraph() {
    const automations = getAllAutomations();
    const nodes = automations.map((a) => ({
        id: a.id,
        label: a.name,
        category: a.category,
        collection: (0, types_1.isFirestoreTrigger)(a.trigger) ? a.trigger.collection : undefined,
    }));
    const edges = [];
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
function validateChainReferences() {
    const allIds = new Set(Object.keys(exports.AUTOMATION_REGISTRY));
    const errors = [];
    getAllAutomations().forEach((automation) => {
        if (automation.chains) {
            automation.chains.forEach((chainId) => {
                if (!allIds.has(chainId)) {
                    errors.push(`Automation "${automation.id}" chains to unknown automation "${chainId}"`);
                }
            });
        }
    });
    return { valid: errors.length === 0, errors };
}
//# sourceMappingURL=automation-registry.js.map