/**
 * Repro for the self-host B1 report: a UI-created API key answering 401 on
 * every /api/mcp call ("Invalid or expired API key").
 *
 * Chain under test, REAL application code end to end:
 *   createApiKeyCallable.run()  → writes the key record through the shim
 *   validateApiKey(rawKey)      → the exact lookup mcpApi runs per request
 *
 * The register's §G warning applies here: every suspected failure mode
 * returns an EMPTY result set rather than throwing, so this test asserts on
 * the POSITIVE match — it fails if validateApiKey silently matches nothing.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { __resetFirestoreShim, __rawSqlForTest } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";

// REAL application code, unmodified:
import { createApiKeyCallable, validateApiKey } from "../api-keys";

const USER = "stefan-test";

function createKey(data: unknown = { name: "audit-key" }) {
  return createApiKeyCallable.run({ data, auth: { uid: USER } } as never);
}

beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 20));
  await __resetFirestoreShim();
  __resetTriggerShim();
});

describe("API key create → validate round trip", () => {
  it("validates a freshly created key (the B1 401 repro)", async () => {
    const created = await createKey();
    expect(created.key).toMatch(/^fk_[0-9a-f]{32}$/);

    const validated = await validateApiKey(created.key);
    expect(validated).not.toBeNull();
    expect(validated!.userId).toBe(USER);
    expect(validated!.scopes).toEqual(["all"]);
  });

  it("stores the record with revokedAt: null (the == null predicate target)", async () => {
    await createKey();
    const { rows } = await __rawSqlForTest(
      `select data ? 'revokedAt' as key_present,
              jsonb_typeof(data->'revokedAt') as typ
         from docs where collection_path = 'apiKeys'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].key_present).toBe(true);
    expect(rows[0].typ).toBe("null");
  });

  it("rejects a wrong key (the negative control)", async () => {
    await createKey();
    const validated = await validateApiKey("fk_" + "0".repeat(32));
    expect(validated).toBeNull();
  });
});
