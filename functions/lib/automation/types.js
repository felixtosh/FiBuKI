"use strict";
/**
 * Automation Metadata Types
 *
 * Defines the structure for automation metadata that is co-located
 * with Cloud Functions triggers and callables.
 *
 * This is the single source of truth for automation documentation.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isFirestoreTrigger = isFirestoreTrigger;
exports.isCallableTrigger = isCallableTrigger;
exports.isScheduledTrigger = isScheduledTrigger;
/**
 * Type guard for Firestore triggers
 */
function isFirestoreTrigger(trigger) {
    return (trigger.type === "document_create" ||
        trigger.type === "document_update" ||
        trigger.type === "document_delete");
}
/**
 * Type guard for callable triggers
 */
function isCallableTrigger(trigger) {
    return trigger.type === "callable";
}
/**
 * Type guard for scheduled triggers
 */
function isScheduledTrigger(trigger) {
    return trigger.type === "scheduled";
}
//# sourceMappingURL=types.js.map