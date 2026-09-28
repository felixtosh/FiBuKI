/**
 * Account provisioning at the verifier seam (#159 findings 1 and 3).
 *
 * A fresh self-host login used to leave nothing behind: no auth_users row in
 * OIDC mode (the verifier only maps sub -> uid) and never a subscriptions
 * document - so the plan resolved to free (every AI feature gated off, #159
 * finding 2), the admin panel counted 0 users, and listAdmins found no
 * admins while the Admin menu rendered around it (finding 3).
 *
 * ensureAccount runs after every successful token verification, memoized per
 * (uid, admin) per process:
 *
 *  1. auth_users row - inserted when missing, so listAllUsers/listAdmins see
 *     every account that has ever authenticated, whichever mode created it.
 *  2. admin claim - in OIDC mode the group claim on the VERIFIED token is
 *     the guard's identity source, so it is materialized into
 *     auth_users.customClaims, the store the admin panel reads: one source,
 *     panel and guard agree, and a group change at the IdP propagates on the
 *     next request. In Better Auth mode the claims store is already the
 *     source (the token was minted FROM it), so syncing is off - an old
 *     token must never write a stale admin bit back.
 *  3. subscriptions/<uid> document - created with the budget fields, plan
 *     from the FIBUKI_PLAN lever (plan-source-shim, default: full). When the
 *     lever is set and the stored plan differs, the plan and its fair-use
 *     limit are re-pointed; usage counters are state, never touched.
 *
 * Failures here log loudly but never turn a valid token into a 401 - the
 * ensure step retries on the next request instead of taking auth down.
 */

import { getFirestore, getSqlClient } from "./firestore-shim";
import { getTenantId } from "./db/tenant";
import { PLANS, createDefaultSubscriptionData } from "../billing/config";
import { envPlanOverride } from "./plan-source-shim";
import type { AuthData } from "./https-shim";
import type { TokenVerifier } from "./host";

export interface EnsureAccountOptions {
  /**
   * True only in OIDC mode, where token.admin (the IdP group claim) is the
   * identity source and must be mirrored into auth_users.customClaims.
   */
  syncAdminClaim: boolean;
  log?: (message: string) => void;
}

/** Memo of (uid|admin) combinations already ensured this process. */
const ensured = new Set<string>();

export function __resetEnsureAccountForTests(): void {
  ensured.clear();
}

function tokenString(token: Record<string, unknown> | undefined, key: string): string | null {
  const v = token?.[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

async function ensureUserRow(auth: AuthData, syncAdminClaim: boolean): Promise<void> {
  const client = await getSqlClient();
  const tenant = getTenantId();
  const admin = auth.token?.admin === true;
  const email = tokenString(auth.token, "email") ?? `${auth.uid}@selfhost.invalid`;
  const name = tokenString(auth.token, "name") ?? email;

  await client.tx(tenant, async (q) => {
    // Any conflict (uid already present, or the email taken by another row)
    // means the account exists in some form - nothing to insert then.
    await q(
      `INSERT INTO auth_users (tenant_id, id, name, email, "emailVerified", "customClaims", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, true, $5, now(), now())
       ON CONFLICT DO NOTHING`,
      [tenant, auth.uid, name, email, admin ? JSON.stringify({ admin: true }) : null],
    );

    if (!syncAdminClaim) return;

    // Read-modify-write so unrelated claims survive the sync.
    const res = await q(
      `SELECT "customClaims" FROM auth_users WHERE tenant_id = $1 AND id = $2`,
      [tenant, auth.uid],
    );
    if (res.rows.length === 0) return;
    let claims: Record<string, unknown> = {};
    const raw = res.rows[0].customClaims;
    if (typeof raw === "string" && raw !== "") {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object") claims = parsed as Record<string, unknown>;
      } catch {
        // Unparseable claims: rebuild from what the token proves.
      }
    }
    if (claims.admin === admin) return;
    claims.admin = admin;
    await q(
      `UPDATE auth_users SET "customClaims" = $3, "updatedAt" = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenant, auth.uid, JSON.stringify(claims)],
    );
  });
}

async function ensureSubscription(uid: string): Promise<void> {
  const db = getFirestore();
  const ref = db.collection("subscriptions").doc(uid);
  const envPlan = envPlanOverride();
  const snap = await ref.get();

  if (!snap.exists) {
    const data: Record<string, unknown> = createDefaultSubscriptionData(uid);
    if (envPlan) {
      data.plan = envPlan;
      data.aiFairUseLimitEur = PLANS[envPlan].aiFairUseLimitEur;
    }
    await ref.set(data);
    return;
  }

  // The lever moves both ways: a stored plan that disagrees with FIBUKI_PLAN
  // is re-pointed (plan + its fair-use limit). Usage counters are state, not
  // config - they stay untouched. Without a lever (cloud tier / unset on the
  // Firebase build's shim-free path) the stored plan rules.
  if (envPlan && snap.data()?.plan !== envPlan) {
    await ref.update({
      plan: envPlan,
      aiFairUseLimitEur: PLANS[envPlan].aiFairUseLimitEur,
      updatedAt: new Date(),
    });
  }
}

/** Idempotent per (uid, admin): provision what a logged-in account requires. */
export async function ensureAccount(auth: AuthData, opts: EnsureAccountOptions): Promise<void> {
  const admin = auth.token?.admin === true;
  const key = `${auth.uid}|${admin}`;
  if (ensured.has(key)) return;

  await ensureUserRow(auth, opts.syncAdminClaim);
  await ensureSubscription(auth.uid);

  ensured.add(key);
}

/**
 * Wrap a TokenVerifier so every successfully verified request provisions its
 * account. The auth decision is never altered: a provisioning failure logs
 * and the request proceeds (it retries on the next one).
 */
export function withAccountProvisioning(
  verify: TokenVerifier,
  opts: EnsureAccountOptions,
): TokenVerifier {
  const log = opts.log ?? ((m: string) => console.error(m));
  return async (token) => {
    const auth = await verify(token);
    if (auth) {
      try {
        await ensureAccount(auth, opts);
      } catch (err) {
        log(
          `ensure-account: provisioning failed for uid ${auth.uid} - ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return auth;
  };
}
