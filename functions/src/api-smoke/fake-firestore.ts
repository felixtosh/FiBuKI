/**
 * C1 — a tiny in-memory Firestore Admin double for the app/api route smoke
 * suite. Enough of the Admin SDK surface for the data-plane routes the cutover
 * rides on: doc get/set/update/delete, collection add, and where/orderBy/limit
 * queries with the `==` and `in` operators.
 *
 * It is NOT a Firestore emulator — it pins the *route decisions* (owner-scoping,
 * happy path) without a live database. The route tests seed a fixture, then call
 * the real Next handler with a stubbed identity and assert one owner never sees
 * another's row. Deliberately dependency-free so the harness itself runs under
 * the functions profile locally (the route suite that consumes it is CI-only,
 * needing root node_modules for next/firebase-admin).
 *
 * FieldValue/Timestamp sentinels are the shapes produced by the test's
 * firebase-admin/firestore mock (see route-owner-scoping.test.ts), not the real
 * SDK — applyPatch understands `{ __sentinel }` markers.
 */

export type DocData = Record<string, unknown>;

interface Sentinel {
  __sentinel: "delete" | "serverTimestamp" | "arrayUnion" | "arrayRemove";
  values?: unknown[];
}

function isSentinel(v: unknown): v is Sentinel {
  return typeof v === "object" && v !== null && "__sentinel" in v;
}

/** Milliseconds for anything the routes might sort/compare on. */
function toComparable(v: unknown): number | string {
  if (v == null) return -Infinity;
  if (typeof v === "object" && v !== null && "toMillis" in v) {
    return (v as { toMillis: () => number }).toMillis();
  }
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return String(v);
}

function compare(a: unknown, b: unknown): number {
  const ca = toComparable(a);
  const cb = toComparable(b);
  if (ca < cb) return -1;
  if (ca > cb) return 1;
  return 0;
}

interface Filter {
  field: string;
  op: "==" | "!=" | "in" | "<" | "<=" | ">" | ">=";
  value: unknown;
}

function matchesFilter(fieldValue: unknown, filter: Filter): boolean {
  switch (filter.op) {
    case "==":
      return fieldValue === filter.value;
    case "!=":
      return fieldValue !== filter.value;
    case "in":
      return Array.isArray(filter.value) && filter.value.includes(fieldValue);
    case "<":
      return compare(fieldValue, filter.value) < 0;
    case "<=":
      return compare(fieldValue, filter.value) <= 0;
    case ">":
      return compare(fieldValue, filter.value) > 0;
    case ">=":
      return compare(fieldValue, filter.value) >= 0;
    default:
      return false;
  }
}

function applyPatch(current: DocData, patch: DocData): DocData {
  const next: DocData = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (isSentinel(value)) {
      switch (value.__sentinel) {
        case "delete":
          delete next[key];
          break;
        case "serverTimestamp":
          next[key] = { toMillis: () => 0, toDate: () => new Date(0) };
          break;
        case "arrayUnion": {
          const arr = Array.isArray(next[key]) ? [...(next[key] as unknown[])] : [];
          for (const v of value.values ?? []) if (!arr.includes(v)) arr.push(v);
          next[key] = arr;
          break;
        }
        case "arrayRemove": {
          const arr = Array.isArray(next[key]) ? [...(next[key] as unknown[])] : [];
          next[key] = arr.filter((v) => !(value.values ?? []).includes(v));
          break;
        }
      }
    } else {
      next[key] = value;
    }
  }
  return next;
}

export interface DocSnapshot {
  id: string;
  exists: boolean;
  ref: FakeDocRef;
  data(): DocData | undefined;
}

export interface QuerySnapshot {
  empty: boolean;
  size: number;
  docs: DocSnapshot[];
  forEach(cb: (doc: DocSnapshot) => void): void;
}

export class FakeDocRef {
  constructor(
    private db: FakeFirestore,
    public readonly collectionName: string,
    public readonly id: string
  ) {}

  async get(): Promise<DocSnapshot> {
    return this.db._snapshot(this.collectionName, this.id);
  }

  async set(data: DocData, options?: { merge?: boolean }): Promise<void> {
    if (options?.merge) {
      this.db._update(this.collectionName, this.id, data);
    } else {
      this.db._set(this.collectionName, this.id, { ...data });
    }
  }

  async update(patch: DocData): Promise<void> {
    if (this.db._raw(this.collectionName, this.id) === undefined) {
      throw new Error(`No document to update: ${this.collectionName}/${this.id}`);
    }
    this.db._update(this.collectionName, this.id, patch);
  }

  async delete(): Promise<void> {
    this.db._delete(this.collectionName, this.id);
  }
}

export class FakeQuery {
  constructor(
    private db: FakeFirestore,
    private collectionName: string,
    private filters: Filter[] = [],
    private orders: { field: string; dir: "asc" | "desc" }[] = [],
    private lim?: number
  ) {}

  where(field: string, op: Filter["op"], value: unknown): FakeQuery {
    return new FakeQuery(
      this.db,
      this.collectionName,
      [...this.filters, { field, op, value }],
      this.orders,
      this.lim
    );
  }

  orderBy(field: string, dir: "asc" | "desc" = "asc"): FakeQuery {
    return new FakeQuery(
      this.db,
      this.collectionName,
      this.filters,
      [...this.orders, { field, dir }],
      this.lim
    );
  }

  limit(n: number): FakeQuery {
    return new FakeQuery(this.db, this.collectionName, this.filters, this.orders, n);
  }

  async get(): Promise<QuerySnapshot> {
    let rows = this.db._entries(this.collectionName);
    for (const filter of this.filters) {
      rows = rows.filter((r) => matchesFilter(r.data[filter.field], filter));
    }
    // Later orderBy clauses are tie-breakers, so apply in reverse with a stable sort.
    for (const order of [...this.orders].reverse()) {
      const factor = order.dir === "desc" ? -1 : 1;
      rows = rows
        .map((r, i) => ({ r, i }))
        .sort((a, b) => {
          const c = compare(a.r.data[order.field], b.r.data[order.field]) * factor;
          return c !== 0 ? c : a.i - b.i;
        })
        .map((x) => x.r);
    }
    if (this.lim != null) rows = rows.slice(0, this.lim);
    const docs = rows.map((r) => this.db._snapshot(this.collectionName, r.id));
    return {
      empty: docs.length === 0,
      size: docs.length,
      docs,
      forEach: (cb) => docs.forEach(cb),
    };
  }
}

export class FakeCollectionRef {
  constructor(private db: FakeFirestore, private name: string) {}

  doc(id?: string): FakeDocRef {
    return new FakeDocRef(this.db, this.name, id ?? this.db._newId());
  }

  async add(data: DocData): Promise<FakeDocRef> {
    const id = this.db._newId();
    this.db._set(this.name, id, { ...data });
    return new FakeDocRef(this.db, this.name, id);
  }

  where(field: string, op: Filter["op"], value: unknown): FakeQuery {
    return new FakeQuery(this.db, this.name).where(field, op, value);
  }

  orderBy(field: string, dir: "asc" | "desc" = "asc"): FakeQuery {
    return new FakeQuery(this.db, this.name).orderBy(field, dir);
  }

  limit(n: number): FakeQuery {
    return new FakeQuery(this.db, this.name).limit(n);
  }

  get(): Promise<QuerySnapshot> {
    return new FakeQuery(this.db, this.name).get();
  }
}

interface WriteOp {
  kind: "delete" | "update" | "set";
  collectionName: string;
  id: string;
  data?: DocData;
}

export class FakeBatch {
  private ops: WriteOp[] = [];
  constructor(private db: FakeFirestore) {}

  delete(ref: FakeDocRef): FakeBatch {
    this.ops.push({ kind: "delete", collectionName: ref.collectionName, id: ref.id });
    return this;
  }

  update(ref: FakeDocRef, data: DocData): FakeBatch {
    this.ops.push({ kind: "update", collectionName: ref.collectionName, id: ref.id, data });
    return this;
  }

  set(ref: FakeDocRef, data: DocData): FakeBatch {
    this.ops.push({ kind: "set", collectionName: ref.collectionName, id: ref.id, data });
    return this;
  }

  async commit(): Promise<void> {
    for (const op of this.ops) {
      if (op.kind === "delete") this.db._delete(op.collectionName, op.id);
      else if (op.kind === "update") this.db._update(op.collectionName, op.id, op.data ?? {});
      else this.db._set(op.collectionName, op.id, { ...(op.data ?? {}) });
    }
    this.ops = [];
  }
}

export class FakeFirestore {
  private collections = new Map<string, Map<string, DocData>>();
  private autoId = 0;

  reset(): void {
    this.collections.clear();
    this.autoId = 0;
  }

  /** Seed a fixture document (test helper, not part of the Admin surface). */
  seed(collectionName: string, id: string, data: DocData): void {
    this._set(collectionName, id, { ...data });
  }

  collection(name: string): FakeCollectionRef {
    return new FakeCollectionRef(this, name);
  }

  batch(): FakeBatch {
    return new FakeBatch(this);
  }

  // --- internals used by the ref/query/batch classes -----------------------

  private coll(name: string): Map<string, DocData> {
    let m = this.collections.get(name);
    if (!m) {
      m = new Map();
      this.collections.set(name, m);
    }
    return m;
  }

  _newId(): string {
    return `auto-${++this.autoId}`;
  }

  _raw(name: string, id: string): DocData | undefined {
    return this.coll(name).get(id);
  }

  _entries(name: string): { id: string; data: DocData }[] {
    return [...this.coll(name).entries()].map(([id, data]) => ({ id, data }));
  }

  _snapshot(name: string, id: string): DocSnapshot {
    const data = this.coll(name).get(id);
    const ref = new FakeDocRef(this, name, id);
    return {
      id,
      exists: data !== undefined,
      ref,
      data: () => (data === undefined ? undefined : { ...data }),
    };
  }

  _set(name: string, id: string, data: DocData): void {
    this.coll(name).set(id, data);
  }

  _update(name: string, id: string, patch: DocData): void {
    const current = this.coll(name).get(id) ?? {};
    this.coll(name).set(id, applyPatch(current, patch));
  }

  _delete(name: string, id: string): void {
    this.coll(name).delete(id);
  }
}
