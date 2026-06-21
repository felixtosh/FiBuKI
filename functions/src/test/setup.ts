/**
 * Test Setup for Cloud Functions
 *
 * Provides utilities for mocking Firebase services and testing callable functions.
 */

import { vi, beforeEach, afterEach } from "vitest";
// FieldValue imported for type reference only - not used directly in mocks

// ============================================================================
// FieldValue Handling
// ============================================================================

/**
 * Process FieldValue operations in update data
 */
function processFieldValues(
  existing: Record<string, unknown>,
  updates: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...existing };

  for (const [key, value] of Object.entries(updates)) {
    if (value && typeof value === "object") {
      const constructorName = value.constructor?.name || "";

      if (constructorName === "ArrayUnionTransform" || constructorName.includes("ArrayUnion")) {
        // Handle FieldValue.arrayUnion
        const elements = (value as { elements: unknown[] }).elements || [];
        const currentArray = Array.isArray(result[key]) ? result[key] as unknown[] : [];
        result[key] = [...new Set([...currentArray, ...elements])];
      } else if (constructorName === "ArrayRemoveTransform" || constructorName.includes("ArrayRemove")) {
        // Handle FieldValue.arrayRemove
        const elements = (value as { elements: unknown[] }).elements || [];
        const currentArray = Array.isArray(result[key]) ? result[key] as unknown[] : [];
        result[key] = currentArray.filter((item) => !elements.includes(item));
      } else if (constructorName === "ServerTimestampTransform" || constructorName.includes("Timestamp")) {
        result[key] = new Date();
      } else if (constructorName === "DeleteTransform" || constructorName.includes("Delete")) {
        delete result[key];
      } else {
        // Regular object value
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}

// ============================================================================
// Mock Firestore
// ============================================================================

export interface MockDocSnapshot {
  id: string;
  exists: boolean;
  data: () => Record<string, unknown> | undefined;
  ref: MockDocRef;
}

export interface MockDocRef {
  id: string;
  _collection: string; // Internal tracking for batch operations
  get: () => Promise<MockDocSnapshot>;
  set: (data: Record<string, unknown>) => Promise<void>;
  update: (data: Record<string, unknown>) => Promise<void>;
  delete: () => Promise<void>;
}

export interface MockQuerySnapshot {
  empty: boolean;
  docs: MockDocSnapshot[];
  size: number;
}

export interface MockCollectionRef {
  doc: (id?: string) => MockDocRef;
  add: (data: Record<string, unknown>) => Promise<MockDocRef>;
  where: (field: string, op: string, value: unknown) => MockQuery;
}

export interface MockQuery {
  where: (field: string, op: string, value: unknown) => MockQuery;
  orderBy: (field: string, direction?: string) => MockQuery;
  limit: (n: number) => MockQuery;
  get: () => Promise<MockQuerySnapshot>;
}

export interface MockFirestore {
  collection: (name: string) => MockCollectionRef;
  batch: () => MockWriteBatch;
  runTransaction: <T>(fn: (tx: MockTransaction) => Promise<T>) => Promise<T>;
}

export interface MockWriteBatch {
  set: (ref: MockDocRef, data: Record<string, unknown>) => MockWriteBatch;
  update: (ref: MockDocRef, data: Record<string, unknown>) => MockWriteBatch;
  delete: (ref: MockDocRef) => MockWriteBatch;
  commit: () => Promise<void>;
}

export interface MockTransaction {
  get: (ref: MockDocRef) => Promise<MockDocSnapshot>;
  set: (ref: MockDocRef, data: Record<string, unknown>) => MockTransaction;
  update: (ref: MockDocRef, data: Record<string, unknown>) => MockTransaction;
  delete: (ref: MockDocRef) => MockTransaction;
}

// ============================================================================
// In-Memory Store
// ============================================================================

/**
 * In-memory document store for testing
 */
export class InMemoryStore {
  private collections: Map<string, Map<string, Record<string, unknown>>> = new Map();
  private autoIdCounter = 0;

  clear(): void {
    this.collections.clear();
    this.autoIdCounter = 0;
  }

  getCollection(name: string): Map<string, Record<string, unknown>> {
    if (!this.collections.has(name)) {
      this.collections.set(name, new Map());
    }
    return this.collections.get(name)!;
  }

  generateId(): string {
    return `auto_${++this.autoIdCounter}`;
  }

  setDoc(collection: string, id: string, data: Record<string, unknown>): void {
    this.getCollection(collection).set(id, { ...data });
  }

  getDoc(collection: string, id: string): Record<string, unknown> | undefined {
    return this.getCollection(collection).get(id);
  }

  deleteDoc(collection: string, id: string): void {
    this.getCollection(collection).delete(id);
  }

  queryDocs(
    collection: string,
    filters?: Array<{ field: string; op: string; value: unknown }>
  ): Array<{ id: string; data: Record<string, unknown> }> {
    const col = this.getCollection(collection);
    const results: Array<{ id: string; data: Record<string, unknown> }> = [];

    for (const [id, data] of col) {
      let matches = true;

      if (filters) {
        // Coerce Date | Timestamp | primitive to a comparable number for </<=/>/>= ops.
        const toComparable = (v: unknown): number => {
          if (v instanceof Date) return v.getTime();
          if (v && typeof v === "object" && typeof (v as { toDate?: () => Date }).toDate === "function") {
            return (v as { toDate: () => Date }).toDate().getTime();
          }
          if (typeof v === "number") return v;
          if (typeof v === "string") return Date.parse(v) || 0;
          return Number(v);
        };

        for (const filter of filters) {
          const fieldValue = data[filter.field];
          switch (filter.op) {
            case "==":
              if (fieldValue !== filter.value) matches = false;
              break;
            case "!=":
              if (fieldValue === filter.value) matches = false;
              break;
            case ">":
              if (!(toComparable(fieldValue) > toComparable(filter.value))) matches = false;
              break;
            case ">=":
              if (!(toComparable(fieldValue) >= toComparable(filter.value))) matches = false;
              break;
            case "<":
              if (!(toComparable(fieldValue) < toComparable(filter.value))) matches = false;
              break;
            case "<=":
              if (!(toComparable(fieldValue) <= toComparable(filter.value))) matches = false;
              break;
            case "array-contains":
              if (!Array.isArray(fieldValue) || !fieldValue.includes(filter.value)) matches = false;
              break;
            case "in":
              if (!Array.isArray(filter.value) || !(filter.value as unknown[]).includes(fieldValue)) matches = false;
              break;
          }
        }
      }

      if (matches) {
        results.push({ id, data: { ...data } });
      }
    }

    return results;
  }
}

// Global store instance
export const store = new InMemoryStore();

// ============================================================================
// Create Mock Firestore
// ============================================================================

export function createMockFirestore(): MockFirestore {
  const createDocRef = (collection: string, id: string): MockDocRef => ({
    id,
    _collection: collection, // Track collection for batch operations
    get: async () => {
      const data = store.getDoc(collection, id);
      return {
        id,
        exists: !!data,
        data: () => data,
        ref: createDocRef(collection, id),
      };
    },
    set: async (data) => {
      store.setDoc(collection, id, data);
    },
    update: async (data) => {
      const existing = store.getDoc(collection, id);
      if (existing) {
        store.setDoc(collection, id, processFieldValues(existing, data));
      }
    },
    delete: async () => {
      store.deleteDoc(collection, id);
    },
  });

  const createQuery = (collection: string, filters: Array<{ field: string; op: string; value: unknown }> = []): MockQuery => ({
    where: (field: string, op: string, value: unknown) => {
      return createQuery(collection, [...filters, { field, op, value }]);
    },
    orderBy: () => createQuery(collection, filters),
    limit: () => createQuery(collection, filters),
    get: async () => {
      const results = store.queryDocs(collection, filters);
      return {
        empty: results.length === 0,
        size: results.length,
        docs: results.map((r) => ({
          id: r.id,
          exists: true,
          data: () => r.data,
          ref: createDocRef(collection, r.id),
        })),
      };
    },
  });

  const createCollectionRef = (name: string): MockCollectionRef => ({
    doc: (id?: string) => createDocRef(name, id || store.generateId()),
    add: async (data) => {
      const id = store.generateId();
      store.setDoc(name, id, data);
      return createDocRef(name, id);
    },
    where: (field: string, op: string, value: unknown) => createQuery(name, [{ field, op, value }]),
  });

  return {
    collection: (name: string) => createCollectionRef(name),
    batch: () => {
      const operations: Array<() => void> = [];
      const batch: MockWriteBatch = {
        set: (ref, data) => {
          const collection = ref._collection || "unknown";
          operations.push(() => store.setDoc(collection, ref.id, data));
          return batch;
        },
        update: (ref, data) => {
          const collection = ref._collection || "unknown";
          operations.push(() => {
            const existing = store.getDoc(collection, ref.id);
            if (existing) {
              store.setDoc(collection, ref.id, processFieldValues(existing, data));
            }
          });
          return batch;
        },
        delete: (ref) => {
          const collection = ref._collection || "unknown";
          operations.push(() => store.deleteDoc(collection, ref.id));
          return batch;
        },
        commit: async () => {
          for (const op of operations) {
            op();
          }
        },
      };
      return batch;
    },
    runTransaction: async <T>(fn: (tx: MockTransaction) => Promise<T>): Promise<T> => {
      const tx: MockTransaction = {
        get: async (ref) => ref.get(),
        set: (ref, data) => {
          const collection = ref._collection || "unknown";
          store.setDoc(collection, ref.id, data);
          return tx;
        },
        update: (ref, data) => {
          const collection = ref._collection || "unknown";
          const existing = store.getDoc(collection, ref.id);
          if (existing) {
            store.setDoc(collection, ref.id, processFieldValues(existing, data));
          }
          return tx;
        },
        delete: (ref) => {
          const collection = ref._collection || "unknown";
          store.deleteDoc(collection, ref.id);
          return tx;
        },
      };
      return fn(tx);
    },
  };
}

// ============================================================================
// Test Context Builder
// ============================================================================

export interface TestContext {
  userId: string;
  db: MockFirestore;
  request: {
    auth: { uid: string };
    data: unknown;
  };
  logAIUsage: ReturnType<typeof vi.fn>;
}

export function createTestContext(userId: string, data: unknown = {}): TestContext {
  return {
    userId,
    db: createMockFirestore() as unknown as MockFirestore,
    request: {
      auth: { uid: userId },
      data,
    },
    logAIUsage: vi.fn(),
  };
}

// ============================================================================
// Test Lifecycle Hooks
// ============================================================================

export function setupTestHooks(): void {
  beforeEach(() => {
    store.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });
}

// ============================================================================
// Test Data Generators
// ============================================================================

export function createTestTransaction(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    userId: "test-user",
    sourceId: "test-source",
    date: new Date("2024-01-15"),
    amount: -100,
    currency: "EUR",
    name: "Test Transaction",
    description: null,
    partner: "Test Partner",
    reference: "REF123",
    partnerIban: null,
    dedupeHash: "hash123",
    fileIds: [],
    isComplete: false,
    partnerId: null,
    partnerType: null,
    partnerMatchedBy: null,
    partnerMatchConfidence: null,
    partnerSuggestions: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function createTestFile(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    userId: "test-user",
    fileName: "test-invoice.pdf",
    fileType: "application/pdf",
    fileSize: 1024,
    storagePath: "files/test-user/test.pdf",
    downloadUrl: "https://storage.example.com/test.pdf",
    extractionComplete: false,
    transactionIds: [],
    uploadedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function createTestPartner(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    userId: "test-user",
    name: "Test Partner",
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function createTestSource(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    userId: "test-user",
    name: "Test Bank Account",
    accountKind: "checking",
    iban: "DE89370400440532013000",
    currency: "EUR",
    type: "manual",
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}
