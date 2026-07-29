/**
 * Drop-in for `firebase-functions/v2/firestore`: trigger registration
 * functions that record handlers in an in-process registry instead of
 * deploying Cloud Functions. The bus feeds every document change through
 * the registry, building firebase-functions-shaped events.
 *
 * Application trigger modules are imported UNCHANGED — their top-level
 * onDocumentCreated/Updated/Deleted calls land here via module aliasing.
 */

import { onChange, drainChanges, resetBus, DocChange } from "./bus";
import { DocSnapshot, DocRef } from "./firestore-shim";

type TriggerType = "created" | "updated" | "deleted" | "written";

interface Registration {
  type: TriggerType;
  pattern: string[];
  handler: (event: FirestoreEvent) => Promise<void> | void;
}

export interface FirestoreEvent {
  data: unknown;
  params: Record<string, string>;
  id: string;
  document: string;
  time: string;
}

const registry: Registration[] = [];

function matchPath(pattern: string[], path: string): Record<string, string> | null {
  const segs = path.split("/");
  if (segs.length !== pattern.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    if (p.startsWith("{") && p.endsWith("}")) {
      params[p.slice(1, -1)] = segs[i];
    } else if (p !== segs[i]) {
      return null;
    }
  }
  return params;
}

function snap(change: DocChange, data: Record<string, unknown> | undefined): DocSnapshot {
  return new DocSnapshot(change.id, data, new DocRef(change.collectionPath, change.id));
}

async function dispatch(change: DocChange): Promise<void> {
  const kind: TriggerType =
    change.before === undefined ? "created" : change.after === undefined ? "deleted" : "updated";

  for (const reg of registry) {
    if (reg.type !== kind && reg.type !== "written") continue;
    const params = matchPath(reg.pattern, change.path);
    if (!params) continue;

    let data: unknown;
    if (reg.type === "created") {
      data = snap(change, change.after);
    } else if (reg.type === "deleted") {
      data = snap(change, change.before);
    } else {
      // updated + written get a Change<snapshot>
      data = { before: snap(change, change.before), after: snap(change, change.after) };
    }

    const event: FirestoreEvent = {
      data,
      params,
      id: `selfhost-${change.path}`,
      document: change.path,
      time: new Date().toISOString(),
    };

    try {
      await reg.handler(event);
    } catch (err) {
      // Match Cloud Functions behavior: a throwing trigger doesn't abort the write
      // or other triggers. Log and continue.
      console.error(`[selfhost trigger] handler for ${change.path} (${reg.type}) failed:`, err);
    }
  }
}

onChange(dispatch);

// ---------------------------------------------------------------------------
// Registration API (mirrors firebase-functions/v2/firestore)
// ---------------------------------------------------------------------------

type Opts = string | { document: string; [k: string]: unknown };

function register(
  type: TriggerType,
  opts: Opts,
  handler: (event: FirestoreEvent) => Promise<void> | void,
) {
  const document = typeof opts === "string" ? opts : opts.document;
  registry.push({ type, pattern: document.split("/"), handler });
  // Return value stands in for the deployed CloudFunction; also expose the
  // raw handler so tests/server code can invoke it directly if needed.
  return Object.assign(handler, { __selfhostTrigger: { type, document } });
}

export function onDocumentCreated(opts: Opts, handler: (e: FirestoreEvent) => Promise<void> | void) {
  return register("created", opts, handler);
}

export function onDocumentUpdated(opts: Opts, handler: (e: FirestoreEvent) => Promise<void> | void) {
  return register("updated", opts, handler);
}

export function onDocumentDeleted(opts: Opts, handler: (e: FirestoreEvent) => Promise<void> | void) {
  return register("deleted", opts, handler);
}

export function onDocumentWritten(opts: Opts, handler: (e: FirestoreEvent) => Promise<void> | void) {
  return register("written", opts, handler);
}

// ---------------------------------------------------------------------------
// Test / server helpers
// ---------------------------------------------------------------------------

/** Process all pending document changes through registered triggers. */
export const drainTriggers = drainChanges;

export function __resetTriggerShim(): void {
  resetBus();
}

export function __registeredTriggers(): Array<{ type: string; document: string }> {
  return registry.map((r) => ({ type: r.type, document: r.pattern.join("/") }));
}
