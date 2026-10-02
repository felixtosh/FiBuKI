/**
 * Argument generation from a tool's parameter schema, for the attack suites.
 *
 * Every parameter gets a value that passes validation; every id-like one is
 * then pointed at a chosen account. Driving this off the schema, not a hand
 * list, means a tool or parameter added tomorrow is attacked tomorrow.
 */

import { victimValueFor, attackerValueFor } from "./victim";

/** A JSON-schema-ish node: what TOOL_DEFINITIONS and zod both reduce to here. */
export interface ParamNode {
  kind: "string" | "number" | "boolean" | "enum" | "array" | "object" | "any";
  values?: unknown[];
  element?: ParamNode;
  shape?: Record<string, ParamNode>;
  required?: string[];
}

/** A zod v4 schema, read through its internal def (zod is not imported here on purpose:
 * the tools under test use the repo root's zod, the functions package has its own). */
export function fromZod(schema: unknown): ParamNode {
  const def = (schema as { _zod?: { def?: Record<string, unknown> } })?._zod?.def as
    | (Record<string, unknown> & { type: string })
    | undefined;
  if (!def) return { kind: "any" };
  switch (def.type) {
    case "string":
      return { kind: "string" };
    case "number":
    case "int":
    case "bigint":
      return { kind: "number" };
    case "boolean":
      return { kind: "boolean" };
    case "enum":
      return { kind: "enum", values: Object.values(def.entries as Record<string, unknown>) };
    case "literal":
      return { kind: "enum", values: def.values as unknown[] };
    case "array":
      return { kind: "array", element: fromZod(def.element) };
    case "object": {
      const shape: Record<string, ParamNode> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(def.shape as Record<string, unknown>)) {
        shape[k] = fromZod(v);
        const t = (v as { _zod?: { def?: { type?: string } } })._zod?.def?.type;
        if (t !== "optional" && t !== "default" && t !== "nullable") required.push(k);
      }
      return { kind: "object", shape, required };
    }
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "nonoptional":
    case "readonly":
    case "catch":
      return fromZod(def.innerType);
    case "pipe":
      return fromZod(def.in);
    case "union":
      return fromZod((def.options as unknown[])[0]);
    default:
      return { kind: "any" };
  }
}

/** A JSON schema as TOOL_DEFINITIONS declares parameters. */
export function fromJsonSchema(schema: Record<string, unknown> | undefined): ParamNode {
  if (!schema) return { kind: "any" };
  if (Array.isArray(schema.enum)) return { kind: "enum", values: schema.enum };
  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (t) {
    case "string":
      return { kind: "string" };
    case "number":
    case "integer":
      return { kind: "number" };
    case "boolean":
      return { kind: "boolean" };
    case "array":
      return { kind: "array", element: fromJsonSchema(schema.items as Record<string, unknown>) };
    case "object": {
      const shape: Record<string, ParamNode> = {};
      for (const [k, v] of Object.entries((schema.properties as Record<string, Record<string, unknown>>) || {})) {
        shape[k] = fromJsonSchema(v);
      }
      return { kind: "object", shape, required: (schema.required as string[]) || [] };
    }
    default:
      return { kind: "any" };
  }
}

type Pick = (name: string) => unknown;

function coerce(node: ParamNode, value: unknown): unknown {
  if (node.kind === "array") return Array.isArray(value) ? value : [value];
  if (node.kind === "string") return Array.isArray(value) ? value[0] : value;
  return undefined;
}

/** A valid value for `node`; id-like names (by `pick`) get the picked id. */
export function sample(node: ParamNode, name: string, pick: Pick): unknown {
  const id = pick(name);
  const scalarArray = node.kind === "array" && (node.element?.kind === "string" || node.element?.kind === "any");
  if (id !== undefined && (node.kind === "string" || scalarArray)) {
    const v = coerce(node, id);
    if (v !== undefined) return v;
  }
  switch (node.kind) {
    case "string":
      return /date/i.test(name) ? "2026-01-15" : "probe";
    case "number":
      return 1;
    case "boolean":
      return true;
    case "enum":
      return node.values?.[0];
    case "array": {
      const el = node.element ?? { kind: "any" };
      // An array of objects keyed by the parent's name ("transactions": [{...}]).
      return [sample(el, singular(name), pick)];
    }
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.shape ?? {})) out[k] = sample(v, k, pick);
      return out;
    }
    default:
      return "probe";
  }
}

function singular(name: string): string {
  return name.replace(/ies$/, "y").replace(/s$/, "");
}

/** The id-like top-level parameter names of a schema. */
export function idParams(node: ParamNode): string[] {
  return Object.keys(node.shape ?? {}).filter((k) => victimValueFor(k) !== undefined);
}

/**
 * The attack payloads for one schema:
 *   - every id-like parameter pointing at the victim,
 *   - each one alone pointing at the victim with the rest at the attacker
 *     (the "my transaction, your file" shape),
 *   - only the required parameters, victim ids.
 */
export function attackPayloads(node: ParamNode): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const all = sample(node, "", victimValueFor) as Record<string, unknown>;
  out.push(all);
  for (const p of idParams(node)) {
    const mixed = sample(node, "", attackerValueFor) as Record<string, unknown>;
    mixed[p] = sample(node.shape![p], p, victimValueFor);
    out.push(mixed);
  }
  if (node.required) {
    out.push(Object.fromEntries(node.required.map((k) => [k, all[k]])));
  }
  return out;
}

/** The same payload with every id at the attacker's own account. */
export function ownPayload(node: ParamNode): Record<string, unknown> {
  return sample(node, "", attackerValueFor) as Record<string, unknown>;
}
