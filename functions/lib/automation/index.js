"use strict";
/**
 * Automation Module Exports
 *
 * This module provides:
 * - Type definitions for automation metadata
 * - Central registry of all automations
 * - Callable to fetch automation data for admin page
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAutomationsCallable = exports.validateChainReferences = exports.buildAutomationGraph = exports.getTriggerCollections = exports.getAutomationsByCollection = exports.getAutomationsByCategory = exports.getAutomation = exports.getAllAutomations = exports.AUTOMATION_REGISTRY = void 0;
// Types
__exportStar(require("./types"), exports);
// Registry
var automation_registry_1 = require("./automation-registry");
Object.defineProperty(exports, "AUTOMATION_REGISTRY", { enumerable: true, get: function () { return automation_registry_1.AUTOMATION_REGISTRY; } });
Object.defineProperty(exports, "getAllAutomations", { enumerable: true, get: function () { return automation_registry_1.getAllAutomations; } });
Object.defineProperty(exports, "getAutomation", { enumerable: true, get: function () { return automation_registry_1.getAutomation; } });
Object.defineProperty(exports, "getAutomationsByCategory", { enumerable: true, get: function () { return automation_registry_1.getAutomationsByCategory; } });
Object.defineProperty(exports, "getAutomationsByCollection", { enumerable: true, get: function () { return automation_registry_1.getAutomationsByCollection; } });
Object.defineProperty(exports, "getTriggerCollections", { enumerable: true, get: function () { return automation_registry_1.getTriggerCollections; } });
Object.defineProperty(exports, "buildAutomationGraph", { enumerable: true, get: function () { return automation_registry_1.buildAutomationGraph; } });
Object.defineProperty(exports, "validateChainReferences", { enumerable: true, get: function () { return automation_registry_1.validateChainReferences; } });
// Callable
var getAutomationsCallable_1 = require("./getAutomationsCallable");
Object.defineProperty(exports, "getAutomationsCallable", { enumerable: true, get: function () { return getAutomationsCallable_1.getAutomationsCallable; } });
//# sourceMappingURL=index.js.map