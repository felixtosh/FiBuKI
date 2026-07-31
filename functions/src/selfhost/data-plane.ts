/**
 * Client data-plane router (work item 6, slice A): the server side the
 * frontend firestore shim talks to. Wire formats in
 * frontend-shim-design.md §2; policy in data-policy.ts.
 *
 *   POST /__data/query  { path, wheres?, orderBys?, limit? } -> { docs: [{id, data}] }
 *   POST /__data/get    { path }                             -> { exists, id, data|null }
 *   POST /__data/write  { ops: [...] }                       -> { ids: [...] }
 *
 * All routes require a valid Bearer token (the data plane has no
 * anonymous surface). Owner-scoped queries get where("userId","==",uid)
 * injected server-side. One write request = one shim batch; `ifUnchanged`
 * preconditions are checked against the validation-phase reads, then the
 * batch commits — no interleaving hazard in the single-process,
 * single-user selfhost deployment this is built for.
 *
 * Errors use the callable wire shape ({ error: { message, status } }) so
 * the client shim maps one format.
 */

import express from "express";
import type { NextFunction, Request, Response, Router } from "express";
import { getFirestore, DocRef, Query, Timestamp } from "./firestore-shim";
import { decodeWire, encodeWire, WireError } from "./wire-values";
import { makeRateLimiter } from "./rate-limit";
import type { AuthData } from "./https-shim";
import type { TokenVerifier } from "./host";
import {
  Access,
  CollectionPolicy,
  SUBTREE_POLICIES,
  TOP_LEVEL_POLICIES,
  TRANSACTION_HISTORY_POLICY,
  USER_DOC_POLICY,
} from "./data-policy";

const WHERE_OPS = new Set([
  "==", "!=", "<", "<=", ">", ">=", "in", "not-in", "array-contains", "array-contains-any",
]);

class DataPlaneError extends Error {
  constructor(
    public readonly code: "invalid-argument" | "permission-denied" | "not-found" | "aborted" | "unauthenticated",
    message: string,
  ) {
    super(message);
  }
}

const CODE_TO_HTTP: Record<string, number> = {
  "invalid-argument": 400,
  unauthenticated: 401,
  "permission-denied": 403,
  "not-found": 404,
  aborted: 409,
  internal: 500,
};

function sendError(res: Response, code: string, message: string): void {
  res.status(CODE_TO_HTTP[code] ?? 500).json({
    error: { message, status: code.toUpperCase().replace(/-/g, "_") },
  });
}

/* ------------------------------------------------------------------ */
/* Policy resolution                                                   */
/* ------------------------------------------------------------------ */

interface Resolved {
  policy: CollectionPolicy;
  /** doc id must equal uid (subscriptions/{uid}) */
  uidKeyed: boolean;
}

function splitPath(path: unknown): string[] {
  if (typeof path !== "string" || path.length === 0) {
    throw new DataPlaneError("invalid-argument", "path must be a non-empty string");
  }
  const segments = path.split("/");
  if (segments.some((s) => s.length === 0)) {
    throw new DataPlaneError("invalid-argument", `malformed path "${path}"`);
  }
  return segments;
}

/** Resolve the policy governing a COLLECTION path (odd segment count). */
function resolveCollection(segments: string[], uid: string): Resolved {
  if (segments.length % 2 !== 1) {
    throw new DataPlaneError("invalid-argument", `"${segments.join("/")}" is not a collection path`);
  }

  if (segments[0] === "users") {
    if (segments.length === 1) {
      // Listing the users collection is nobody's client business.
      throw new DataPlaneError("permission-denied", "cannot query the users collection");
    }
    if (segments[1] !== uid) {
      throw new DataPlaneError("permission-denied", "cannot access another user's subtree");
    }
    const policy = SUBTREE_POLICIES[segments[2]];
    if (!policy) {
      throw new DataPlaneError("permission-denied", `users subtree "${segments[2]}" is not client-accessible`);
    }
    return { policy, uidKeyed: false };
  }

  if (segments.length === 3 && segments[0] === "transactions" && segments[2] === "history") {
    return { policy: TRANSACTION_HISTORY_POLICY, uidKeyed: false };
  }

  if (segments.length !== 1) {
    throw new DataPlaneError("permission-denied", `subcollection "${segments.join("/")}" is not client-accessible`);
  }

  const policy = TOP_LEVEL_POLICIES[segments[0]];
  if (!policy) {
    throw new DataPlaneError("permission-denied", `collection "${segments[0]}" is not client-accessible`);
  }
  return {
    policy,
    uidKeyed: policy.read === "uidKey",
  };
}

/** Resolve the policy governing a DOC path (even segment count). */
function resolveDoc(segments: string[], uid: string): Resolved {
  if (segments.length % 2 !== 0) {
    throw new DataPlaneError("invalid-argument", `"${segments.join("/")}" is not a document path`);
  }
  if (segments[0] === "users" && segments.length === 2) {
    if (segments[1] !== uid) {
      throw new DataPlaneError("permission-denied", "cannot access another user's document");
    }
    return { policy: USER_DOC_POLICY, uidKeyed: false };
  }
  return resolveCollection(segments.slice(0, -1), uid);
}

function accessGranted(access: Access, auth: AuthData): boolean {
  switch (access) {
    case "authed":
      return true;
    case "admin":
      return auth.token?.admin === true;
    case "owner":
    case "uidKey":
      return true; // row/id check happens at the call site
    case "none":
      return false;
  }
}

function requireAccess(access: Access, auth: AuthData, what: string): void {
  if (!accessGranted(access, auth)) {
    throw new DataPlaneError("permission-denied", `${what} denied by data policy`);
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function deepGet(data: unknown, dotted: string): unknown {
  let v: unknown = data;
  for (const part of dotted.split(".")) {
    if (typeof v !== "object" || v === null) return undefined;
    v = (v as Record<string, unknown>)[part];
  }
  return v;
}

// The shim's update/merge path splits field-path keys on "." and walks into
// nested objects (deepSet). A client key like "a.__proto__.x" would reach
// Object.prototype — reject any path segment that names a prototype hook.
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function assertSafeFieldPaths(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    for (const segment of key.split(".")) {
      if (FORBIDDEN_SEGMENTS.has(segment)) {
        throw new DataPlaneError("invalid-argument", `unsafe field path "${key}"`);
      }
    }
  }
}

/** Precondition check shared by update/set/delete — 409 aborts on mismatch. */
function checkPrecondition(
  existing: Record<string, unknown> | undefined,
  ifUnchanged: Record<string, unknown> | undefined,
  docPath: string,
): void {
  if (!ifUnchanged) return;
  for (const [field, wireExpected] of Object.entries(ifUnchanged)) {
    const expected = decodeWire(wireExpected, false);
    if (!wireEquals(deepGet(existing, field), expected)) {
      throw new DataPlaneError("aborted", `precondition failed on ${docPath}: field "${field}" changed`);
    }
  }
}

function wireEquals(a: unknown, b: unknown): boolean {
  if (a instanceof Timestamp || b instanceof Timestamp) {
    return (
      a instanceof Timestamp &&
      b instanceof Timestamp &&
      a.seconds === b.seconds &&
      a.nanoseconds === b.nanoseconds
    );
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => wireEquals(x, b[i]));
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    return (
      ka.length === kb.length &&
      ka.every(
        (k, i) =>
          k === kb[i] &&
          wireEquals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  }
  return a === b;
}

function ownsRow(data: Record<string, unknown> | undefined, uid: string): boolean {
  return data !== undefined && data.userId === uid;
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

interface WhereClause {
  field: string;
  op: string;
  value: unknown;
}

interface WriteOp {
  type: "add" | "set" | "update" | "delete";
  path: string;
  data?: unknown;
  merge?: boolean;
  ifUnchanged?: Record<string, unknown>;
}

const MAX_OPS = 500;

export function createDataPlane(
  verifyToken: TokenVerifier,
  options?: { jsonLimit?: string },
): Router {
  const router = express.Router();
  router.use(express.json({ limit: options?.jsonLimit ?? "32mb" }));

  // DoS/bruteforce backstop; the client shim is chatty, so the cap is high.
  router.use(makeRateLimiter(1000));

  // Data plane always requires a verified identity.
  router.use(async (req: Request & { fibukiAuth?: AuthData }, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      sendError(res, "unauthenticated", "Data plane requires a Bearer token.");
      return;
    }
    try {
      const auth = await verifyToken(header.slice("Bearer ".length));
      if (auth === null) {
        sendError(res, "unauthenticated", "Invalid authentication token.");
        return;
      }
      req.fibukiAuth = auth;
      next();
    } catch (err) {
      next(err);
    }
  });

  const authOf = (req: Request): AuthData => (req as Request & { fibukiAuth: AuthData }).fibukiAuth;

  router.post("/query", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = authOf(req);
      const { path, wheres, orderBys, limit } = (req.body ?? {}) as {
        path?: unknown;
        wheres?: WhereClause[];
        orderBys?: Array<{ field: string; dir: string }>;
        limit?: unknown;
      };
      const segments = splitPath(path);
      const resolved = resolveCollection(segments, auth.uid);
      requireAccess(resolved.policy.read, auth, `read on ${segments.join("/")}`);

      let q: Query = getFirestore().collection(segments.join("/"));
      if (resolved.policy.read === "owner") q = q.where("userId", "==", auth.uid);

      const nameFilters: WhereClause[] = [];
      for (const w of wheres ?? []) {
        if (typeof w?.field !== "string" || !WHERE_OPS.has(w?.op)) {
          throw new DataPlaneError("invalid-argument", `bad where clause ${JSON.stringify(w)}`);
        }
        if (w.field === "__name__") {
          if (w.op !== "==" && w.op !== "in") {
            throw new DataPlaneError("invalid-argument", `__name__ only supports == and in, got ${w.op}`);
          }
          nameFilters.push({ ...w, value: decodeWire(w.value, false) });
        } else {
          q = q.where(w.field, w.op, decodeWire(w.value, false));
        }
      }
      for (const o of orderBys ?? []) {
        if (typeof o?.field !== "string" || (o.dir !== "asc" && o.dir !== "desc")) {
          throw new DataPlaneError("invalid-argument", `bad orderBy ${JSON.stringify(o)}`);
        }
        q = q.orderBy(o.field, o.dir);
      }
      // A limit at the query level would slice BEFORE the __name__ and
      // uidKey post-filters run, dropping own rows that sort behind foreign
      // ones — defer to a post-slice whenever a post-filter is in play.
      const postFilter = nameFilters.length > 0 || resolved.uidKeyed;
      if (limit !== undefined) {
        if (typeof limit !== "number" || limit < 0 || !Number.isInteger(limit)) {
          throw new DataPlaneError("invalid-argument", "limit must be a non-negative integer");
        }
        if (!postFilter) q = q.limit(limit);
      }

      const snap = await q.get();
      let docs = snap.docs;
      for (const f of nameFilters) {
        docs = docs.filter((d) =>
          f.op === "==" ? d.id === f.value : Array.isArray(f.value) && f.value.includes(d.id),
        );
      }
      if (resolved.uidKeyed) docs = docs.filter((d) => d.id === auth.uid);
      if (typeof limit === "number" && postFilter) docs = docs.slice(0, limit);

      res.json({ docs: docs.map((d) => ({ id: d.id, data: encodeWire(d.data()) })) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/get", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = authOf(req);
      const segments = splitPath((req.body ?? {}).path);
      const resolved = resolveDoc(segments, auth.uid);
      requireAccess(resolved.policy.read, auth, `read on ${segments.join("/")}`);
      if (resolved.uidKeyed && segments[segments.length - 1] !== auth.uid) {
        throw new DataPlaneError("permission-denied", "document is keyed to another user");
      }

      const snap = await getFirestore().doc(segments.join("/")).get();
      const data = snap.exists ? (snap.data() as Record<string, unknown>) : undefined;
      if (snap.exists && resolved.policy.read === "owner" && !ownsRow(data, auth.uid)) {
        throw new DataPlaneError("permission-denied", "document belongs to another user");
      }
      res.json({
        exists: snap.exists,
        id: segments[segments.length - 1],
        data: snap.exists ? encodeWire(data) : null,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/write", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = authOf(req);
      const ops = (req.body ?? {}).ops as WriteOp[] | undefined;
      if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_OPS) {
        throw new DataPlaneError("invalid-argument", `ops must be an array of 1..${MAX_OPS}`);
      }

      const db = getFirestore();
      type Prepared =
        | { kind: "set"; ref: DocRef; data: Record<string, unknown>; merge: boolean; id: string }
        | { kind: "update"; ref: DocRef; data: Record<string, unknown>; id: string }
        | { kind: "delete"; ref: DocRef; id: string }
        | { kind: "skip"; id: string };
      const prepared: Prepared[] = [];

      // Phase 1: validate every op (policy + ownership + preconditions).
      for (const op of ops) {
        const segments = splitPath(op?.path);

        if (op.type === "add") {
          const resolved = resolveCollection(segments, auth.uid);
          requireAccess(resolved.policy.create, auth, `create in ${segments.join("/")}`);
          const data = decodeWire(op.data, true);
          if (typeof data !== "object" || data === null || Array.isArray(data)) {
            throw new DataPlaneError("invalid-argument", "add op needs an object data payload");
          }
          const record = data as Record<string, unknown>;
          assertSafeFieldPaths(record);
          if (resolved.policy.create === "owner" && record.userId !== auth.uid) {
            throw new DataPlaneError("permission-denied", `create in ${segments[0]} requires userId === your uid`);
          }
          const ref = db.collection(segments.join("/")).doc();
          prepared.push({ kind: "set", ref, data: record, merge: false, id: ref.id });
          continue;
        }

        const resolved = resolveDoc(segments, auth.uid);
        const docPath = segments.join("/");
        const id = segments[segments.length - 1];
        if (resolved.uidKeyed && id !== auth.uid) {
          throw new DataPlaneError("permission-denied", "document is keyed to another user");
        }
        const ref = db.doc(docPath);
        const snap = await ref.get();
        const existing = snap.exists ? (snap.data() as Record<string, unknown>) : undefined;
        const ownerRules = resolved.policy.update === "owner" || resolved.policy.create === "owner";

        const data = op.data !== undefined ? decodeWire(op.data, true) : undefined;
        if (data !== undefined && (typeof data !== "object" || data === null || Array.isArray(data))) {
          throw new DataPlaneError("invalid-argument", `${op.type} op needs an object data payload`);
        }
        const record = data as Record<string, unknown> | undefined;
        if (record) assertSafeFieldPaths(record);
        // An owner-scoped write may never point userId at someone else.
        if (ownerRules && record && "userId" in record && record.userId !== auth.uid) {
          throw new DataPlaneError("permission-denied", "cannot write a foreign userId");
        }

        if (op.type === "set") {
          if (existing) {
            requireAccess(resolved.policy.update, auth, `update on ${docPath}`);
            if (resolved.policy.update === "owner" && !ownsRow(existing, auth.uid)) {
              throw new DataPlaneError("permission-denied", "document belongs to another user");
            }
          } else {
            requireAccess(resolved.policy.create, auth, `create on ${docPath}`);
            if (resolved.policy.create === "owner" && record?.userId !== auth.uid) {
              throw new DataPlaneError("permission-denied", `create in ${segments[0]} requires userId === your uid`);
            }
          }
          if (!record) throw new DataPlaneError("invalid-argument", "set op needs data");
          checkPrecondition(existing, op.ifUnchanged, docPath);
          prepared.push({ kind: "set", ref, data: record, merge: op.merge === true, id });
        } else if (op.type === "update") {
          requireAccess(resolved.policy.update, auth, `update on ${docPath}`);
          if (!existing) throw new DataPlaneError("not-found", `update on missing doc ${docPath}`);
          if (resolved.policy.update === "owner" && !ownsRow(existing, auth.uid)) {
            throw new DataPlaneError("permission-denied", "document belongs to another user");
          }
          if (!record) throw new DataPlaneError("invalid-argument", "update op needs data");
          checkPrecondition(existing, op.ifUnchanged, docPath);
          prepared.push({ kind: "update", ref, data: record, id });
        } else if (op.type === "delete") {
          requireAccess(resolved.policy.delete, auth, `delete on ${docPath}`);
          checkPrecondition(existing, op.ifUnchanged, docPath);
          if (!existing) {
            prepared.push({ kind: "skip", id }); // Firestore deletes are idempotent
            continue;
          }
          if (resolved.policy.delete === "owner" && !ownsRow(existing, auth.uid)) {
            throw new DataPlaneError("permission-denied", "document belongs to another user");
          }
          prepared.push({ kind: "delete", ref, id });
        } else {
          throw new DataPlaneError("invalid-argument", `unknown op type ${JSON.stringify(op.type)}`);
        }
      }

      // Phase 2: commit as one shim batch (triggers fire post-commit).
      const batch = db.batch();
      for (const p of prepared) {
        if (p.kind === "set") batch.set(p.ref, p.data, p.merge ? { merge: true } : undefined);
        else if (p.kind === "update") batch.update(p.ref, p.data);
        else if (p.kind === "delete") batch.delete(p.ref);
      }
      await batch.commit();

      res.json({ ids: prepared.map((p) => p.id) });
    } catch (err) {
      next(err);
    }
  });

  // Error funnel: policy/wire errors get their code, the rest stay opaque.
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof DataPlaneError) {
      sendError(res, err.code, err.message);
    } else if (err instanceof WireError) {
      sendError(res, "invalid-argument", err.message);
    } else if (!res.headersSent) {
      console.error("[data-plane] internal error:", err);
      sendError(res, "internal", "INTERNAL");
    }
  });

  return router;
}
