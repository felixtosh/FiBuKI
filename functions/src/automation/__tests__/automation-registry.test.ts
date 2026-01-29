import { describe, it, expect, vi, beforeAll } from "vitest";

// Mock firebase-admin before importing anything that uses it
vi.mock("firebase-admin/firestore", () => ({
  getFirestore: vi.fn(() => ({
    collection: vi.fn(),
    doc: vi.fn(),
    batch: vi.fn(),
  })),
  FieldValue: {
    serverTimestamp: vi.fn(),
    arrayUnion: vi.fn(),
    arrayRemove: vi.fn(),
    increment: vi.fn(),
  },
  Timestamp: {
    now: vi.fn(() => ({ toDate: () => new Date() })),
    fromDate: vi.fn(),
  },
}));

vi.mock("firebase-functions/v2/firestore", () => ({
  onDocumentUpdated: vi.fn(() => vi.fn()),
  onDocumentCreated: vi.fn(() => vi.fn()),
  onDocumentDeleted: vi.fn(() => vi.fn()),
}));

vi.mock("firebase-functions/v2/https", () => ({
  onCall: vi.fn(() => vi.fn()),
  HttpsError: class HttpsError extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
}));

import {
  AUTOMATION_REGISTRY,
  getAllAutomations,
  getAutomation,
  getAutomationsByCategory,
  getAutomationsByCollection,
  getTriggerCollections,
  buildAutomationGraph,
  validateChainReferences,
} from "../automation-registry";
import { AutomationMeta, isFirestoreTrigger } from "../types";

describe("automation-registry", () => {
  describe("AUTOMATION_REGISTRY", () => {
    it("should have at least one automation registered", () => {
      expect(Object.keys(AUTOMATION_REGISTRY).length).toBeGreaterThan(0);
    });

    it("should have all required fields for each automation", () => {
      getAllAutomations().forEach((automation) => {
        expect(automation.id).toBeTruthy();
        expect(automation.name).toBeTruthy();
        expect(automation.description).toBeTruthy();
        expect(automation.trigger).toBeDefined();
        expect(automation.effects).toBeInstanceOf(Array);
        expect(automation.effects.length).toBeGreaterThan(0);
        expect(automation.category).toBeTruthy();
      });
    });

    it("should have unique IDs", () => {
      const ids = getAllAutomations().map((a) => a.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("should have IDs matching registry keys", () => {
      Object.entries(AUTOMATION_REGISTRY).forEach(([key, automation]) => {
        expect(automation.id).toBe(key);
      });
    });
  });

  describe("getAllAutomations", () => {
    it("should return all automations as array", () => {
      const automations = getAllAutomations();
      expect(automations.length).toBe(Object.keys(AUTOMATION_REGISTRY).length);
    });
  });

  describe("getAutomation", () => {
    it("should return automation by ID", () => {
      const firstKey = Object.keys(AUTOMATION_REGISTRY)[0];
      const automation = getAutomation(firstKey);
      expect(automation).toBeDefined();
      expect(automation?.id).toBe(firstKey);
    });

    it("should return undefined for unknown ID", () => {
      expect(getAutomation("nonexistent")).toBeUndefined();
    });
  });

  describe("getAutomationsByCategory", () => {
    it("should filter by category", () => {
      const matchingAutomations = getAutomationsByCategory("matching");
      matchingAutomations.forEach((a) => {
        expect(a.category).toBe("matching");
      });
    });

    it("should return empty array for unused category", () => {
      const result = getAutomationsByCategory("cleanup");
      expect(result).toBeInstanceOf(Array);
    });
  });

  describe("getAutomationsByCollection", () => {
    it("should filter by trigger collection", () => {
      const fileAutomations = getAutomationsByCollection("files");
      fileAutomations.forEach((a) => {
        expect(isFirestoreTrigger(a.trigger)).toBe(true);
        if (isFirestoreTrigger(a.trigger)) {
          expect(a.trigger.collection).toBe("files");
        }
      });
    });
  });

  describe("getTriggerCollections", () => {
    it("should return unique collections", () => {
      const collections = getTriggerCollections();
      expect(new Set(collections).size).toBe(collections.length);
    });

    it("should be sorted alphabetically", () => {
      const collections = getTriggerCollections();
      const sorted = [...collections].sort();
      expect(collections).toEqual(sorted);
    });
  });

  describe("buildAutomationGraph", () => {
    it("should build valid graph", () => {
      const graph = buildAutomationGraph();
      expect(graph.nodes.length).toBe(getAllAutomations().length);
    });

    it("should have valid edge references", () => {
      const graph = buildAutomationGraph();
      const nodeIds = new Set(graph.nodes.map((n) => n.id));

      graph.edges.forEach((edge) => {
        expect(nodeIds.has(edge.source)).toBe(true);
        // Note: target might reference automations not yet added to registry
        // This is checked by validateChainReferences
      });
    });

    it("should include category on nodes", () => {
      const graph = buildAutomationGraph();
      graph.nodes.forEach((node) => {
        expect(node.category).toBeTruthy();
      });
    });
  });

  describe("validateChainReferences", () => {
    it("should validate all chain references exist", () => {
      const result = validateChainReferences();
      if (!result.valid) {
        console.warn("Chain validation errors:", result.errors);
      }
      // Note: This may fail if chains reference automations not yet added
      // Comment out this assertion while adding new automations
      expect(result.valid).toBe(true);
    });
  });

  describe("automation effects", () => {
    it("should have valid entity types", () => {
      const validEntities = [
        "transaction",
        "file",
        "partner",
        "noReceiptCategory",
        "source",
        "fileConnection",
        "workerRequest",
        "notification",
      ];

      getAllAutomations().forEach((automation) => {
        automation.effects.forEach((effect) => {
          expect(validEntities).toContain(effect.entity);
        });
      });
    });

    it("should have valid action types", () => {
      const validActions = ["create", "update", "delete"];

      getAllAutomations().forEach((automation) => {
        automation.effects.forEach((effect) => {
          expect(validActions).toContain(effect.action);
        });
      });
    });

    it("should have non-empty fields arrays", () => {
      getAllAutomations().forEach((automation) => {
        automation.effects.forEach((effect) => {
          expect(effect.fields.length).toBeGreaterThan(0);
        });
      });
    });
  });

  describe("automation learnings", () => {
    it("should have valid entity types for learnings", () => {
      const validEntities = [
        "transaction",
        "file",
        "partner",
        "noReceiptCategory",
        "source",
        "fileConnection",
        "workerRequest",
        "notification",
      ];

      getAllAutomations().forEach((automation) => {
        if (automation.learns) {
          automation.learns.forEach((learning) => {
            expect(validEntities).toContain(learning.entity);
            expect(learning.fields.length).toBeGreaterThan(0);
            expect(learning.description).toBeTruthy();
          });
        }
      });
    });
  });
});
