/**
 * Automation Module Exports
 *
 * This module provides:
 * - Type definitions for automation metadata
 * - Central registry of all automations
 * - Callable to fetch automation data for admin page
 */

// Types
export * from "./types";

// Registry
export {
  AUTOMATION_REGISTRY,
  getAllAutomations,
  getAutomation,
  getAutomationsByCategory,
  getAutomationsByCollection,
  getTriggerCollections,
  buildAutomationGraph,
  validateChainReferences,
} from "./automation-registry";

// Callable
export { getAutomationsCallable } from "./getAutomationsCallable";
