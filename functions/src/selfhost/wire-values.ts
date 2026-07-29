/**
 * Wire value codec for the data plane (work item 6, slice A).
 *
 * JSON with tagged specials, both directions (frontend-shim-design.md §2.1):
 *   Timestamp        <-> { "__ts": [seconds, nanoseconds] }
 *   Sentinels (client->server only, inside write payloads):
 *     { "__sv": "serverTimestamp" }
 *     { "__sv": "increment", "n": <number> }
 *     { "__sv": "arrayUnion", "v": [...] } / { "__sv": "arrayRemove", "v": [...] }
 *     { "__sv": "deleteField" }
 *
 * Unknown "__"-tagged shapes throw — a silently-passed-through tag would
 * land in the store as data and read back as garbage.
 */

import { FieldValue, Timestamp } from "./firestore-shim";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Decode wire JSON into shim values. Sentinels only allowed when writing. */
export function decodeWire(value: unknown, allowSentinels: boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => decodeWire(v, allowSentinels));
  if (!isPlainObject(value)) return value;

  if ("__ts" in value) {
    const ts = value.__ts;
    if (
      !Array.isArray(ts) ||
      ts.length !== 2 ||
      !Number.isFinite(ts[0]) ||
      !Number.isInteger(ts[1]) ||
      ts[1] < 0 ||
      ts[1] > 999_999_999
    ) {
      // Validate the nanoseconds range here rather than letting the
      // Timestamp constructor throw a plain Error (500 in the funnel).
      throw new WireError(`malformed __ts value: ${JSON.stringify(ts)}`);
    }
    return new Timestamp(ts[0], ts[1]);
  }

  if ("__sv" in value) {
    if (!allowSentinels) throw new WireError(`sentinel ${JSON.stringify(value.__sv)} not allowed here`);
    switch (value.__sv) {
      case "serverTimestamp":
        return FieldValue.serverTimestamp();
      case "increment":
        if (typeof value.n !== "number") throw new WireError("increment sentinel needs numeric n");
        return FieldValue.increment(value.n);
      case "arrayUnion":
        if (!Array.isArray(value.v)) throw new WireError("arrayUnion sentinel needs array v");
        return FieldValue.arrayUnion(...value.v.map((x) => decodeWire(x, false)));
      case "arrayRemove":
        if (!Array.isArray(value.v)) throw new WireError("arrayRemove sentinel needs array v");
        return FieldValue.arrayRemove(...value.v.map((x) => decodeWire(x, false)));
      case "deleteField":
        return FieldValue.delete();
      default:
        throw new WireError(`unknown sentinel ${JSON.stringify(value.__sv)}`);
    }
  }

  const anyTag = Object.keys(value).find((k) => k.startsWith("__"));
  if (anyTag) throw new WireError(`unknown wire tag "${anyTag}"`);

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    // "__proto__" is already dead (the "__" tag check above); refuse the
    // rest of the prototype-polluting trio just as loudly. Literal
    // comparisons on purpose — the guard shape CodeQL recognizes.
    if (k === "__proto__" || k === "constructor" || k === "prototype") {
      throw new WireError(`unsafe field name "${k}"`);
    }
    out[k] = decodeWire(v, allowSentinels);
  }
  return out;
}

/** Encode shim values into wire JSON (Timestamps tagged, undefined dropped). */
export function encodeWire(value: unknown): unknown {
  if (value instanceof Timestamp) return { __ts: [value.seconds, value.nanoseconds] };
  if (value instanceof Date) return { __ts: [Math.floor(value.getTime() / 1000), (value.getTime() % 1000) * 1e6] };
  if (Array.isArray(value)) return value.map(encodeWire);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // Sink guard (decode refuses these; literal comparisons on purpose)
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      if (v !== undefined) out[k] = encodeWire(v);
    }
    return out;
  }
  return value;
}

export class WireError extends Error {}
