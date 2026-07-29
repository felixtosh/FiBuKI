/**
 * SQL pushdown for flattened collections (docs/rewrite-goals.md §Phase 1).
 *
 * Compiles a shim query (filters / orderBy / startAfter / limit) into a
 * SELECT against the collection's real table, using the generated columns
 * from collections.ts. The contract with the shim's JS query pipeline:
 *
 *   - Every compiled WHERE is a SUPERSET of the JS filter semantics — the
 *     shim re-runs the full JS pipeline on the returned rows, so a filter
 *     the compiler cannot express exactly is simply not pushed (the row
 *     comes back and JS drops it). Pushdown is a performance layer; the JS
 *     pipeline (pinned by the parity suite) stays the semantics referee.
 *   - LIMIT is only pushed when every filter compiled EXACTLY, every
 *     orderBy field is a generated column, and any cursor compiled — a
 *     truncated superset would otherwise lose rows the JS pipeline wanted.
 *
 * Comparison fidelity notes:
 *   - text comparisons/sorts use COLLATE "C" (byte order ≈ the JS
 *     comparator's code-unit order; both match real Firestore's UTF-8
 *     ordering for the app's data).
 *   - the JS comparator treats missing fields and json-null as -Infinity;
 *     SQL NULLs sort ASC NULLS FIRST / DESC NULLS LAST to match, and < / <=
 *     conditions OR-in json-null rows.
 *   - timestamps compare at microseconds in SQL vs milliseconds in JS; app
 *     writes have millisecond precision (Timestamp.now()/fromDate), and
 *     where they don't, microseconds is what real Firestore does.
 */

import { Timestamp } from "@google-cloud/firestore";
import { FlatKind, FlatSpec, jsonNode } from "./collections";

export interface FilterSpec {
  field: string;
  op: string;
  value: unknown;
}

export interface OrderSpec {
  field: string;
  dir: "asc" | "desc";
}

/** Cursor already resolved by the shim (snap form → field values + doc id). */
export interface CursorSpec {
  values: unknown[];
  /** Doc id for the implicit __name__ tiebreak; null for the values form. */
  snapId: string | null;
}

export interface CompiledFlatQuery {
  sql: string;
  params: unknown[];
}

function paramFor(kind: FlatKind, v: unknown): { ok: boolean; value?: unknown } {
  switch (kind) {
    case "text":
      return typeof v === "string" ? { ok: true, value: v } : { ok: false };
    case "boolean":
      return typeof v === "boolean" ? { ok: true, value: v } : { ok: false };
    case "number":
      return typeof v === "number" && !Number.isNaN(v) ? { ok: true, value: v } : { ok: false };
    case "timestamp":
      if (v instanceof Timestamp) return { ok: true, value: v.toDate() };
      if (v instanceof Date) return { ok: true, value: v };
      return { ok: false };
  }
}

/** Path-shaped __name__ values resolve to their last segment (see shim). */
function toId(v: unknown): string {
  return String(v).split("/").pop() as string;
}

export function compileFlatQuery(
  spec: FlatSpec,
  tenantId: string,
  filters: FilterSpec[],
  orders: OrderSpec[],
  limitN: number | null,
  offsetN: number,
  cursor: CursorSpec | null,
): CompiledFlatQuery {
  const params: unknown[] = [];
  const p = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const colOf = (field: string): string => `"${spec.fields[field].col}"`;
  const cmpColOf = (field: string): string =>
    spec.fields[field].kind === "text" ? `${colOf(field)} COLLATE "C"` : colOf(field);

  let exact = true; // every filter compiled with exactly-JS semantics
  const conds: string[] = [`tenant_id = ${p(tenantId)}`];

  for (const f of filters) {
    if (f.field === "__name__") {
      if (f.op === "==") {
        conds.push(`id = ${p(toId(f.value))}`);
      } else if (f.op === "in" && Array.isArray(f.value) && f.value.length > 0) {
        conds.push(`id IN (${(f.value as unknown[]).map((v) => p(toId(v))).join(", ")})`);
      } else {
        exact = false;
      }
      continue;
    }
    const ff = spec.fields[f.field];
    if (!ff) {
      exact = false;
      continue;
    }
    switch (f.op) {
      case "==": {
        const pv = paramFor(ff.kind, f.value);
        if (!pv.ok) {
          exact = false; // null / type-mismatch equality stays JS-side
          break;
        }
        conds.push(`${colOf(f.field)} = ${p(pv.value)}`);
        break;
      }
      case "in": {
        const vals = Array.isArray(f.value) ? (f.value as unknown[]).map((v) => paramFor(ff.kind, v)) : null;
        if (!vals || vals.length === 0 || vals.some((x) => !x.ok)) {
          exact = false;
          break;
        }
        conds.push(`${colOf(f.field)} IN (${vals.map((x) => p(x.value)).join(", ")})`);
        break;
      }
      case ">":
      case ">=": {
        const pv = paramFor(ff.kind, f.value);
        if (!pv.ok) {
          exact = false;
          break;
        }
        // json-null (-Infinity in JS) can never satisfy > / >=.
        conds.push(`${cmpColOf(f.field)} ${f.op} ${p(pv.value)}`);
        break;
      }
      case "<":
      case "<=": {
        const pv = paramFor(ff.kind, f.value);
        if (!pv.ok) {
          exact = false;
          break;
        }
        // json-null is -Infinity to the JS comparator, so it matches < / <=.
        conds.push(
          `(${cmpColOf(f.field)} ${f.op} ${p(pv.value)} OR jsonb_typeof(${jsonNode(f.field)}) = 'null')`,
        );
        // For text the JS comparator coerces -Infinity to the string
        // "-Infinity", which is not below EVERY string — superset, not exact.
        if (ff.kind === "text") exact = false;
        break;
      }
      default:
        // !=, not-in, array-contains(-any) etc. stay JS-side.
        exact = false;
    }
  }

  const allOrdersMapped = orders.every((o) => spec.fields[o.field] !== undefined);
  let orderSql = "";
  if (orders.length > 0 && allOrdersMapped) {
    const parts = orders.map(
      (o) => `${cmpColOf(o.field)} ${o.dir === "desc" ? "DESC NULLS LAST" : "ASC NULLS FIRST"}`,
    );
    const lastDir = orders[orders.length - 1].dir;
    parts.push(`id COLLATE "C" ${lastDir === "desc" ? "DESC" : "ASC"}`);
    orderSql = ` ORDER BY ${parts.join(", ")}`;
  }

  // Keyset cursor: rows strictly past the cursor position in sort order.
  let cursorCompiled = cursor === null;
  if (cursor !== null && exact && allOrdersMapped && orders.length > 0) {
    const n = Math.min(orders.length, cursor.values.length);
    const resolved: unknown[] = [];
    let ok = true;
    for (let i = 0; i < n; i++) {
      const pv = paramFor(spec.fields[orders[i].field].kind, cursor.values[i]);
      if (!pv.ok) {
        ok = false;
        break;
      }
      resolved.push(pv.value);
    }
    if (ok && (n > 0 || cursor.snapId !== null)) {
      const ph = resolved.map((v) => p(v));
      const branches: string[] = [];
      for (let i = 0; i < n; i++) {
        const clauses: string[] = [];
        for (let j = 0; j < i; j++) clauses.push(`${colOf(orders[j].field)} = ${ph[j]}`);
        clauses.push(
          orders[i].dir === "desc"
            ? `(${cmpColOf(orders[i].field)} < ${ph[i]} OR ${colOf(orders[i].field)} IS NULL)`
            : `${cmpColOf(orders[i].field)} > ${ph[i]}`,
        );
        branches.push(clauses.join(" AND "));
      }
      if (cursor.snapId !== null) {
        const clauses: string[] = [];
        for (let j = 0; j < n; j++) clauses.push(`${colOf(orders[j].field)} = ${ph[j]}`);
        const lastDir = orders[orders.length - 1].dir;
        clauses.push(`id COLLATE "C" ${lastDir === "desc" ? "<" : ">"} ${p(cursor.snapId)}`);
        branches.push(clauses.join(" AND "));
      }
      conds.push(`(${branches.map((b) => `(${b})`).join(" OR ")})`);
      cursorCompiled = true;
    }
  }

  // LIMIT only on a provably-not-narrower query; OFFSET always stays JS-side,
  // so the SQL limit covers offset + limit rows.
  const limitSql =
    exact && allOrdersMapped && orders.length > 0 && cursorCompiled && limitN !== null
      ? ` LIMIT ${limitN + offsetN}`
      : "";

  return {
    sql: `SELECT id, data FROM ${spec.table} WHERE ${conds.join(" AND ")}${orderSql}${limitSql}`,
    params,
  };
}
