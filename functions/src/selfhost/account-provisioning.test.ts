/**
 * #159 findings 1-3: self-host account lifecycle.
 *
 * (1) A first successful login provisions the account records the rest of the
 *     app assumes: an auth_users row and a subscriptions/<uid> document with
 *     the budget fields present.
 * (2) The plan on self-host comes from FIBUKI_PLAN, defaulting to the full
 *     (pro) plan - decision on #159 (Felix, 2026-09-27). No billing code is
 *     compiled out; the env var is only a lever. The cloud tier
 *     (FIBUKI_TIER=cloud) ignores it: there, Stripe owns the plan.
 * (3) One admin identity source: in OIDC mode the group claim is the guard's
 *     source, so ensureAccount materializes it into auth_users.customClaims -
 *     the store listAdmins/listAllUsers read. Panel and guard then agree.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getFirestore,
  __rawSqlForTest,
  __resetFirestoreShim,
} from "./firestore-shim";
import { getTenantId } from "./db/tenant";
import { envPlanOverride } from "./plan-source-shim";
import {
  ensureAccount,
  withAccountProvisioning,
  __resetEnsureAccountForTests,
} from "./ensure-account";
import { PLANS, resolvePlanId, hasFeature } from "../billing/config";

const db = getFirestore();

const ENV_KEYS = ["FIBUKI_PLAN", "FIBUKI_TIER"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  await __resetFirestoreShim();
  await __rawSqlForTest(`DELETE FROM auth_users WHERE tenant_id = $1`, [getTenantId()], getTenantId());
  __resetEnsureAccountForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

async function authUserRow(uid: string): Promise<Record<string, unknown> | undefined> {
  const res = await __rawSqlForTest(
    `SELECT * FROM auth_users WHERE tenant_id = $1 AND id = $2`,
    [getTenantId(), uid],
    getTenantId(),
  );
  return res.rows[0];
}

async function seedAuthUser(uid: string, claims?: Record<string, unknown>): Promise<void> {
  await __rawSqlForTest(
    `INSERT INTO auth_users (tenant_id, id, name, email, "emailVerified", "customClaims", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, true, $5, now(), now())`,
    [getTenantId(), uid, uid, `${uid}@test.invalid`, claims ? JSON.stringify(claims) : null],
    getTenantId(),
  );
}

describe("envPlanOverride (FIBUKI_PLAN, decision on #159)", () => {
  it("defaults to the full plan (pro) on the selfhost tier", () => {
    expect(envPlanOverride()).toBe("pro");
  });

  it('accepts "full" as an alias for the pro plan', () => {
    process.env.FIBUKI_PLAN = "full";
    expect(envPlanOverride()).toBe("pro");
  });

  it("honors an explicit plan id", () => {
    process.env.FIBUKI_PLAN = "free";
    expect(envPlanOverride()).toBe("free");
    process.env.FIBUKI_PLAN = "smart";
    expect(envPlanOverride()).toBe("smart");
  });

  it("is inert on the cloud tier - Stripe owns the plan there", () => {
    process.env.FIBUKI_TIER = "cloud";
    expect(envPlanOverride()).toBeNull();
    process.env.FIBUKI_PLAN = "free";
    expect(envPlanOverride()).toBeNull();
  });

  it("rejects an unknown value loudly rather than granting the default", () => {
    process.env.FIBUKI_PLAN = "premium";
    expect(() => envPlanOverride()).toThrow(/FIBUKI_PLAN/);
  });

  it("reaches billing/config through the alias seam: the env plan outranks a stored free plan", () => {
    // billing/config imports "./planSource" - the alias must catch the
    // RELATIVE specifier too, or the gates silently run the Firebase no-op
    // module and a stale subscription row keeps gating features.
    expect(resolvePlanId("free")).toBe("pro");
    expect(hasFeature("free", "aiExtraction")).toBe(true);
  });
});

describe("ensureAccount: first login provisions the account records (#159 finding 1)", () => {
  it("creates the auth_users row and a subscription with budget fields on first sight of a uid", async () => {
    await ensureAccount(
      { uid: "oidc-user-1", token: { email: "eva@example.at", name: "Eva", admin: false } },
      { syncAdminClaim: true },
    );

    const row = await authUserRow("oidc-user-1");
    expect(row).toBeDefined();
    expect(row!.email).toBe("eva@example.at");

    const sub = await db.collection("subscriptions").doc("oidc-user-1").get();
    expect(sub.exists).toBe(true);
    const data = sub.data()!;
    // Plan from the env lever, defaulting to full.
    expect(data.plan).toBe("pro");
    expect(data.aiFairUseLimitEur).toBe(PLANS.pro.aiFairUseLimitEur);
    // Budget fields present - the hand-inserted workaround row the issue
    // describes is exactly these.
    expect(data.aiUsageCurrentPeriodEur).toBe(0);
    expect(data.aiCreditsEur).toBe(0);
    expect(data.aiOverageCurrentPeriodEur).toBe(0);
    expect(data.aiPaused).toBe(false);
    expect(data.transactionCountCurrentMonth).toBe(0);
  });

  it("re-points an existing subscription at the env plan (the lever moves both ways)", async () => {
    await db.collection("subscriptions").doc("u-replan").set({
      userId: "u-replan",
      plan: "free",
      aiFairUseLimitEur: 0,
      aiUsageCurrentPeriodEur: 1.25,
    });

    await ensureAccount({ uid: "u-replan", token: {} }, { syncAdminClaim: false });

    const data = (await db.collection("subscriptions").doc("u-replan").get()).data()!;
    expect(data.plan).toBe("pro");
    expect(data.aiFairUseLimitEur).toBe(PLANS.pro.aiFairUseLimitEur);
    // Usage counters are state, not config - never reset by the sync.
    expect(data.aiUsageCurrentPeriodEur).toBe(1.25);
  });

  it("without an env plan (cloud tier) creates the default free subscription and leaves stored plans alone", async () => {
    process.env.FIBUKI_TIER = "cloud";
    await db.collection("subscriptions").doc("u-cloud").set({ userId: "u-cloud", plan: "smart" });

    await ensureAccount({ uid: "u-cloud", token: {} }, { syncAdminClaim: false });
    await ensureAccount({ uid: "u-cloud-new", token: {} }, { syncAdminClaim: false });

    expect((await db.collection("subscriptions").doc("u-cloud").get()).data()!.plan).toBe("smart");
    const fresh = (await db.collection("subscriptions").doc("u-cloud-new").get()).data()!;
    expect(fresh.plan).toBe("free");
    expect(fresh.aiUsageCurrentPeriodEur).toBe(0);
  });
});

describe("ensureAccount: one admin identity source (#159 finding 3)", () => {
  it("materializes token.admin into customClaims so the panel reads what the guard read", async () => {
    await ensureAccount(
      { uid: "oidc-admin", token: { email: "boss@example.at", admin: true } },
      { syncAdminClaim: true },
    );
    let row = await authUserRow("oidc-admin");
    expect(JSON.parse(String(row!.customClaims))).toMatchObject({ admin: true });

    // Group membership revoked at the IdP -> claim follows on the next request.
    __resetEnsureAccountForTests();
    await ensureAccount(
      { uid: "oidc-admin", token: { email: "boss@example.at", admin: false } },
      { syncAdminClaim: true },
    );
    row = await authUserRow("oidc-admin");
    expect(JSON.parse(String(row!.customClaims)).admin).toBe(false);
  });

  it("preserves unrelated claims while syncing admin", async () => {
    await seedAuthUser("u-claims", { locale: "de-AT" });
    await ensureAccount({ uid: "u-claims", token: { admin: true } }, { syncAdminClaim: true });
    const row = await authUserRow("u-claims");
    expect(JSON.parse(String(row!.customClaims))).toEqual({ locale: "de-AT", admin: true });
  });

  it("never touches claims when the store is the source (Better Auth mode)", async () => {
    await seedAuthUser("u-ba", { admin: true });
    // Better Auth mode: token.admin CAME from customClaims; an old token must
    // not write a stale value back.
    await ensureAccount({ uid: "u-ba", token: { admin: false } }, { syncAdminClaim: false });
    const row = await authUserRow("u-ba");
    expect(JSON.parse(String(row!.customClaims)).admin).toBe(true);
  });
});

describe("withAccountProvisioning: the verifier seam", () => {
  it("provisions on a verified request and stays out of the auth decision", async () => {
    const verify = withAccountProvisioning(
      async (token) => (token === "good" ? { uid: "wrapped-1", token: { admin: false } } : null),
      { syncAdminClaim: true },
    );

    expect(await verify("bad")).toBeNull();
    expect(await authUserRow("wrapped-1")).toBeUndefined();

    const auth = await verify("good");
    expect(auth?.uid).toBe("wrapped-1");
    expect(await authUserRow("wrapped-1")).toBeDefined();
    expect((await db.collection("subscriptions").doc("wrapped-1").get()).exists).toBe(true);
  });
});
