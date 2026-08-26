/**
 * Better Auth wiring for the selfhost build (W1) — the seam defined by
 * better-auth.test.ts, kept deliberately small:
 *
 *   handler   — Better Auth's fetch handler, mounted by the host at /__auth
 *               (chunk 3)
 *   verifier  — TokenVerifier for createHost(): local JWKS verification of
 *               the JWT plugin's tokens PLUS a session-liveness check, so
 *               revoking a session (deleteUser) revokes its tokens too
 *   provisionUser — the ONLY way accounts come to exist (invite-only
 *               product; also the W2/W3 migration entry point). Caller may
 *               provide the uid — Firebase uids are preserved verbatim.
 *   signInEmail — credential sign-in returning a JWKS-verifiable JWT
 *
 * Storage: the auth_* tables authored in db/schema.ts (migration
 * drizzle/0005_better_auth.sql), reached through a custom Better Auth
 * adapter that routes EVERY operation through the firestore-shim's shared
 * SqlClient — same serialized PGlite instance in tests, same node-postgres
 * pool in production, one tenant-scoped app-role transaction per operation
 * (RLS armed, like all document IO). No second connection, no auth
 * container.
 *
 * Token shape (decision 2026-07-21, docs/decisions.md): Better Auth JWT
 * plugin — tokens are locally-decodable JWTs verified against the
 * database-backed JWKS, the same machinery oidc-verifier.ts uses for
 * external issuers. The payload carries `sid` (session id) so the verifier
 * can refuse tokens whose session is gone.
 */

import { betterAuth } from "better-auth";
import { createAdapterFactory } from "better-auth/adapters";
import type { CleanedWhere } from "better-auth/adapters";
import { bearer } from "better-auth/plugins/bearer";
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";
import { createLocalJWKSet, jwtVerify } from "jose";
import { getFirestore, getSqlClient, FieldValue } from "./firestore-shim";
import { getTenantId } from "./db/tenant";
import type { TokenVerifier } from "./host";

export interface SelfhostAuth {
  handler: (req: Request) => Promise<Response>;
  verifier: TokenVerifier;
  provisionUser(opts: {
    uid?: string;
    email: string;
    password?: string;
    displayName?: string;
    admin?: boolean;
  }): Promise<{ uid: string }>;
  signInEmail(email: string, password: string): Promise<{ token: string }>;
}

// ---------------------------------------------------------------------------
// Adapter: Better Auth models -> auth_* tables through the shared SqlClient
// ---------------------------------------------------------------------------

/**
 * timestamptz columns per table, for coercing driver output to Date — the
 * node-postgres pool returns Dates already; PGlite may return ISO strings
 * depending on version, and Better Auth compares these against `new Date()`.
 */
const DATE_COLUMNS: Record<string, ReadonlySet<string>> = {
  auth_users: new Set(["createdAt", "updatedAt"]),
  auth_sessions: new Set(["expiresAt", "createdAt", "updatedAt"]),
  auth_accounts: new Set([
    "accessTokenExpiresAt",
    "refreshTokenExpiresAt",
    "createdAt",
    "updatedAt",
  ]),
  auth_verifications: new Set(["expiresAt", "createdAt", "updatedAt"]),
  auth_organizations: new Set(["createdAt"]),
  auth_members: new Set(["createdAt"]),
  auth_invitations: new Set(["expiresAt", "createdAt"]),
  auth_jwks: new Set(["createdAt", "expiresAt"]),
};

const KNOWN_TABLES = new Set(Object.keys(DATE_COLUMNS));

/**
 * Quote a SQL identifier. Table/field names only ever come from Better
 * Auth's schema (camelCase column names match its default field names
 * 1:1 — see db/schema.ts), but validate anyway: these strings are
 * interpolated into SQL.
 */
function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`selfhost better-auth adapter: invalid SQL identifier "${name}"`);
  }
  return `"${name}"`;
}

function table(model: string): string {
  if (!KNOWN_TABLES.has(model)) {
    throw new Error(`selfhost better-auth adapter: unknown model/table "${model}"`);
  }
  return ident(model);
}

/** Drop tenant_id and coerce timestamptz strings to Date on a returned row. */
function outputRow(model: string, row: Record<string, unknown>): Record<string, unknown> {
  const dates = DATE_COLUMNS[model];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "tenant_id") continue;
    out[k] = dates?.has(k) && typeof v === "string" ? new Date(v) : v;
  }
  return out;
}

interface CompiledWhere {
  sql: string; // starts with "WHERE tenant_id = $1 ..."
  params: unknown[];
}

/**
 * Compile a CleanedWhere list. Semantics mirror Better Auth's own kysely
 * adapter: AND-connected terms are all required, OR-connected terms form one
 * disjunctive group, and both groups must hold. tenant_id scoping is always
 * prepended (RLS enforces it anyway; the explicit predicate keeps the
 * planner on the composite indexes).
 */
function compileWhere(where: CleanedWhere[] | undefined): CompiledWhere {
  const params: unknown[] = [getTenantId()];
  const clauses: { sql: string; connector: "AND" | "OR" }[] = [];

  for (const w of where ?? []) {
    const col = ident(w.field);
    const op = w.operator.toLowerCase();
    const insensitive =
      w.mode === "insensitive" &&
      (typeof w.value === "string" ||
        (Array.isArray(w.value) && w.value.every((v) => typeof v === "string")));
    const lhs = insensitive && op !== "contains" && op !== "starts_with" && op !== "ends_with"
      ? `lower(${col})`
      : col;
    const bind = (v: unknown): string => {
      params.push(insensitive && typeof v === "string" ? v.toLowerCase() : v);
      return `$${params.length}`;
    };
    const like = insensitive ? "ILIKE" : "LIKE";

    let sql: string;
    switch (op) {
      case "eq":
        sql = w.value === null ? `${col} IS NULL` : `${lhs} = ${bind(w.value)}`;
        break;
      case "ne":
        sql = w.value === null ? `${col} IS NOT NULL` : `${lhs} <> ${bind(w.value)}`;
        break;
      case "lt":
        sql = `${col} < ${bind(w.value)}`;
        break;
      case "lte":
        sql = `${col} <= ${bind(w.value)}`;
        break;
      case "gt":
        sql = `${col} > ${bind(w.value)}`;
        break;
      case "gte":
        sql = `${col} >= ${bind(w.value)}`;
        break;
      case "in":
      case "not_in": {
        const values = Array.isArray(w.value) ? w.value : [w.value];
        if (values.length === 0) {
          sql = op === "in" ? "FALSE" : "TRUE";
        } else {
          const list = values.map((v) => bind(v)).join(", ");
          sql = `${lhs} ${op === "in" ? "IN" : "NOT IN"} (${list})`;
        }
        break;
      }
      case "contains":
        sql = `${col} ${like} ${bind(`%${w.value}%`)}`;
        break;
      case "starts_with":
        sql = `${col} ${like} ${bind(`${w.value}%`)}`;
        break;
      case "ends_with":
        sql = `${col} ${like} ${bind(`%${w.value}`)}`;
        break;
      default:
        throw new Error(`selfhost better-auth adapter: unsupported operator "${w.operator}"`);
    }
    clauses.push({ sql, connector: w.connector });
  }

  const ands = clauses.filter((c) => c.connector !== "OR").map((c) => c.sql);
  const ors = clauses.filter((c) => c.connector === "OR").map((c) => c.sql);
  let sql = "WHERE tenant_id = $1";
  if (ands.length) sql += ` AND ${ands.join(" AND ")}`;
  if (ors.length) sql += ` AND (${ors.join(" OR ")})`;
  return { sql, params };
}

type Row = Record<string, unknown>;

async function runSql(sql: string, params: unknown[]): Promise<{ rows: Row[] }> {
  const client = await getSqlClient();
  return client.tx(getTenantId(), (q) => q(sql, params));
}

const selfhostAdapter = createAdapterFactory({
  config: {
    adapterId: "fibuki-selfhost",
    adapterName: "FiBuKI selfhost SQL adapter",
    // JSON fields (organization.metadata, user.customClaims) are stored as
    // text — Better Auth stringifies/parses them for us.
    supportsJSON: false,
    supportsDates: true,
    supportsBooleans: true,
    supportsNumericIds: false,
    // Each operation is one tenant-scoped transaction through the shared
    // SqlClient; cross-operation transactions would deadlock the serialized
    // single-connection PGlite queue, so ops compose sequentially instead.
    transaction: false,
  },
  adapter: () => ({
    async create({ model, data }) {
      const t = table(model);
      const cols = Object.keys(data);
      const params: unknown[] = [getTenantId()];
      const placeholders = cols.map((c) => {
        params.push((data as Row)[c]);
        return `$${params.length}`;
      });
      const res = await runSql(
        `INSERT INTO ${t} (tenant_id${cols.length ? ", " : ""}${cols.map(ident).join(", ")})
         VALUES ($1${placeholders.length ? ", " : ""}${placeholders.join(", ")})
         RETURNING *`,
        params,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return outputRow(model, res.rows[0]) as any;
    },

    async findOne({ model, where, select }) {
      const t = table(model);
      const w = compileWhere(where);
      const projection = select?.length ? select.map(ident).join(", ") : "*";
      const res = await runSql(`SELECT ${projection} FROM ${t} ${w.sql} LIMIT 1`, w.params);
      if (res.rows.length === 0) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return outputRow(model, res.rows[0]) as any;
    },

    async findMany({ model, where, limit, sortBy, offset, select }) {
      const t = table(model);
      const w = compileWhere(where);
      const projection = select?.length ? select.map(ident).join(", ") : "*";
      let sql = `SELECT ${projection} FROM ${t} ${w.sql}`;
      if (sortBy) sql += ` ORDER BY ${ident(sortBy.field)} ${sortBy.direction === "desc" ? "DESC" : "ASC"}`;
      if (typeof limit === "number" && Number.isFinite(limit)) sql += ` LIMIT ${Math.floor(limit)}`;
      if (offset) sql += ` OFFSET ${Math.floor(offset)}`;
      const res = await runSql(sql, w.params);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return res.rows.map((r) => outputRow(model, r)) as any;
    },

    async update({ model, where, update }) {
      const t = table(model);
      const w = compileWhere(where);
      const sets = Object.entries(update as Row).map(([k, v]) => {
        w.params.push(v);
        return `${ident(k)} = $${w.params.length}`;
      });
      if (sets.length === 0) return null;
      const res = await runSql(`UPDATE ${t} SET ${sets.join(", ")} ${w.sql} RETURNING *`, w.params);
      if (res.rows.length === 0) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return outputRow(model, res.rows[0]) as any;
    },

    async updateMany({ model, where, update }) {
      const t = table(model);
      const w = compileWhere(where);
      const sets = Object.entries(update).map(([k, v]) => {
        w.params.push(v);
        return `${ident(k)} = $${w.params.length}`;
      });
      if (sets.length === 0) return 0;
      const res = await runSql(
        `UPDATE ${t} SET ${sets.join(", ")} ${w.sql} RETURNING id`,
        w.params,
      );
      return res.rows.length;
    },

    async delete({ model, where }) {
      const t = table(model);
      const w = compileWhere(where);
      await runSql(`DELETE FROM ${t} ${w.sql}`, w.params);
    },

    async deleteMany({ model, where }) {
      const t = table(model);
      const w = compileWhere(where);
      const res = await runSql(`DELETE FROM ${t} ${w.sql} RETURNING id`, w.params);
      return res.rows.length;
    },

    async count({ model, where }) {
      const t = table(model);
      const w = compileWhere(where);
      const res = await runSql(`SELECT count(*)::int AS n FROM ${t} ${w.sql}`, w.params);
      return Number(res.rows[0]?.n ?? 0);
    },
  }),
});

// ---------------------------------------------------------------------------
// Better Auth instance
// ---------------------------------------------------------------------------

/**
 * Issuer/audience for the JWT plugin and base URL for Better Auth routes.
 * Chunk 3 mounts the handler on the host at /__auth; until a deployment
 * sets FIBUKI_AUTH_ISSUER (or BETTER_AUTH_URL) the tokens are minted and
 * verified in-process against this stable placeholder, which never needs
 * to be reachable.
 */
function issuerUrl(): string {
  return (
    process.env.FIBUKI_AUTH_ISSUER ||
    process.env.BETTER_AUTH_URL ||
    "http://fibuki-selfhost.internal"
  );
}

function superAdminEmail(): string | undefined {
  return process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase() || undefined;
}

/**
 * Against an ephemeral test database (embedded PGlite) Better Auth's dev
 * default secret is acceptable; against a REAL Postgres it is not — the
 * JWKS private keys are encrypted at rest with this secret, and a known
 * constant would let anyone with a database dump forge tokens. DATABASE_URL
 * is exactly the ephemeral/persistent seam (see firestore-shim makeClient).
 */
function resolveSecret(): string | undefined {
  const secret = process.env.FIBUKI_AUTH_SECRET || process.env.BETTER_AUTH_SECRET;
  if (!secret && process.env.DATABASE_URL) {
    throw new Error(
      "selfhost auth: FIBUKI_AUTH_SECRET (or BETTER_AUTH_SECRET) is required when " +
        "DATABASE_URL is set — JWKS private keys are encrypted with it, and a real " +
        "database must never hold keys encrypted with the library's default dev secret",
    );
  }
  return secret || undefined;
}

/**
 * Registered/derived JWT claim names customClaims may never override.
 * firebase-admin's setCustomUserClaims rejects these too (OIDC-reserved),
 * so stripping is parity, not divergence; without it an admin-set claim
 * like {"exp": ...} would mint effectively non-expiring tokens.
 */
export const RESERVED_CLAIMS: ReadonlySet<string> = new Set([
  "iss",
  "sub",
  "aud",
  "exp",
  "nbf",
  "iat",
  "jti",
  "sid",
]);

function parseClaims(user: Record<string, unknown>): Record<string, unknown> {
  const raw = user.customClaims;
  if (typeof raw !== "string" || raw === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!RESERVED_CLAIMS.has(k)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The invite gate — same data, same semantics as the Firebase build
 * (CLAUDE.md auth section): allowedEmails collection, SUPER_ADMIN_EMAIL
 * exempt. Enforced in the user.create database hook so EVERY account path
 * is gated — provisionUser AND social sign-ins (Google auto-creates a user
 * on first login; without the hook that would bypass invite-only).
 */
async function assertInvited(email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (normalized === superAdminEmail()) return;
  const snap = await getFirestore()
    .collection("allowedEmails")
    .where("email", "==", normalized)
    .limit(1)
    .get();
  if (snap.empty) {
    throw new Error(
      `selfhost auth: ${normalized} is not in allowedEmails — this product is invite-only`,
    );
  }
}

/**
 * Record an access request from a non-invited social sign-in — the self-host
 * equivalent of the Firebase build's `submitAccessRequest` callable.
 *
 * The Firebase flow lets Google auto-create the user (so it is authenticated),
 * the callable records the request from that auth context, then the client
 * deletes the user. Here the invite gate blocks creation outright, so there is
 * never an authenticated caller to run a callable — we record it server-side,
 * straight from the create hook, before throwing to block the account.
 *
 * Same collection and shape the admin UI already listens on (`accessRequests`,
 * dedupe by (email, pending)); the client data-policy forbids client creates,
 * so this server-side write is the only path in. Self-host social sign-in is
 * Google-only, so the provider is always "google".
 */
async function recordAccessRequest(user: {
  email: string;
  name?: string | null;
  image?: string | null;
}): Promise<void> {
  const email = user.email.trim().toLowerCase();
  const displayName = user.name ?? null;
  const photoURL = user.image ?? null;
  const db = getFirestore();
  const existing = await db
    .collection("accessRequests")
    .where("email", "==", email)
    .where("status", "==", "pending")
    .limit(1)
    .get();
  if (!existing.empty) {
    // Refresh the existing pending request rather than pile up duplicates.
    await existing.docs[0].ref.update({
      requestedAt: FieldValue.serverTimestamp(),
      displayName,
      photoURL,
      provider: "google",
    });
    return;
  }
  await db.collection("accessRequests").doc().set({
    email,
    displayName,
    photoURL,
    provider: "google",
    requestedAt: FieldValue.serverTimestamp(),
    status: "pending",
  });
}

/**
 * Google social provider (decision 2026-07-21, docs/decisions.md): BYO
 * OAuth client via env — "same features, bring your own OAuth". Absent env
 * simply leaves the provider unregistered; email/password keeps working.
 * The OAuth redirect URI to register at Google is
 * `${FIBUKI_AUTH_ISSUER}/__auth/callback/google`.
 */
/**
 * BYO-OAuth social providers, each registered only when BOTH halves of its
 * credential pair are present — a half-configured provider would render a button
 * that can only produce an error.
 *
 * GitHub is here because it was reachable on the Firebase build but not on
 * self-host, which left any GitHub-only account with no way in at all (one such
 * account exists in the migrated data) and contradicted the rule that both tiers
 * ship the same features.
 *
 * Redirect URIs to register, where <issuer> is FIBUKI_AUTH_ISSUER:
 *   <issuer>/__auth/callback/google
 *   <issuer>/__auth/callback/github
 */
function socialProviders() {
  const providers: Record<string, { clientId: string; clientSecret: string }> = {};

  const pairs = [
    ["google", process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET],
    ["github", process.env.GITHUB_CLIENT_ID, process.env.GITHUB_CLIENT_SECRET],
  ] as const;

  for (const [name, clientId, clientSecret] of pairs) {
    if (clientId && clientSecret) providers[name] = { clientId, clientSecret };
  }

  // Better Auth treats an empty object and undefined differently; keep undefined
  // so nothing is mounted when nothing is configured.
  return Object.keys(providers).length > 0 ? providers : undefined;
}

/**
 * Origins Better Auth will accept a post-sign-in callbackURL for.
 *
 * Better Auth trusts only its own baseURL by default. The documented deploy
 * shape puts the web app and the API on SEPARATE hostnames (deploy/selfhost:
 * the web and api hosts of one deployment), because the api's CORS layer expects
 * a split origin — so every social sign-in callback points at an origin that is
 * not the baseURL, and Better Auth rejects it with
 * 403 INVALID_CALLBACK_URL. That presents as "Google sign-in unavailable" with
 * no other signal.
 *
 * FIBUKI_WEB_ORIGIN already carries the web origin(s) for the CORS layer
 * (host.ts), so reuse it rather than adding a second source of truth. Same
 * comma-separated form. The issuer is always trusted implicitly by Better Auth;
 * including it is harmless and makes single-origin deploys explicit.
 */
function trustedOrigins(issuer: string): string[] {
  const web = (process.env.FIBUKI_WEB_ORIGIN || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    // "*" is a valid CORS value but meaningless (and unsafe) as a callback
    // allowlist, so drop it rather than trusting every origin.
    .filter((o) => o !== "*");
  return Array.from(new Set([issuer, ...web]));
}

function buildAuth() {
  const issuer = issuerUrl();
  return betterAuth({
    baseURL: issuer,
    basePath: "/__auth",
    secret: resolveSecret(),
    database: selfhostAdapter,
    telemetry: { enabled: false },
    trustedOrigins: trustedOrigins(issuer),
    emailAndPassword: {
      enabled: true,
      // Invite-only product: accounts exist only via provisionUser.
      disableSignUp: true,
    },
    socialProviders: socialProviders(),
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            try {
              await assertInvited(user.email);
            } catch (err) {
              // A non-invited account creation. provisionUser gates earlier
              // (it calls assertInvited before the create fires), so in
              // practice this branch only trips for a social sign-in — Google
              // auto-creating a stranger on first login. Parity with the
              // Firebase build: record an access request an admin can act on,
              // then block the account. A recording failure must never mask
              // the invite block, so it is best-effort.
              await recordAccessRequest(user).catch((e) =>
                console.error("selfhost auth: failed to record access request", e),
              );
              throw err;
            }
            return { data: user };
          },
        },
      },
    },
    user: {
      modelName: "auth_users",
      additionalFields: {
        // firebase-admin custom-claims port (chunk 2 wires
        // setCustomUserClaims onto this) — a JSON string, like Firebase
        // stores arbitrary claim objects.
        customClaims: { type: "string", required: false, input: false },
      },
    },
    session: { modelName: "auth_sessions" },
    account: { modelName: "auth_accounts" },
    verification: { modelName: "auth_verifications" },
    plugins: [
      organization({
        schema: {
          organization: { modelName: "auth_organizations" },
          member: { modelName: "auth_members" },
          invitation: { modelName: "auth_invitations" },
        },
      }),
      // Lets server-side calls (and later the client shim) present the raw
      // session token as `Authorization: Bearer` — used by signInEmail to
      // mint the JWT right after sign-in.
      bearer(),
      jwt({
        schema: { jwks: { modelName: "auth_jwks" } },
        jwt: {
          issuer,
          audience: issuer,
          definePayload: ({ user, session }) => {
            const claims = parseClaims(user);
            const admin =
              claims.admin === true || user.email.toLowerCase() === superAdminEmail();
            return {
              ...claims,
              email: user.email,
              email_verified: user.emailVerified,
              name: user.name,
              admin,
              // Session id: the verifier refuses tokens whose session is
              // gone (deleteUser kills sessions -> kills tokens).
              sid: session.id,
            };
          },
        },
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

export async function createSelfhostAuth(): Promise<SelfhostAuth> {
  // Fail fast if the database (and its migrations) can't come up.
  await getSqlClient();
  const auth = buildAuth();
  const issuer = issuerUrl();

  // Local JWKS verification with one refetch on key-miss (first token after
  // boot, or key rotation) — same machinery as oidc-verifier.ts, but the
  // key set comes from the auth_jwks table instead of a remote issuer.
  let keySet: ReturnType<typeof createLocalJWKSet> | null = null;
  const fetchKeySet = async () => createLocalJWKSet(await auth.api.getJwks());
  const verifyJwt = async (token: string) => {
    if (!keySet) keySet = await fetchKeySet();
    try {
      return await jwtVerify(token, keySet, { issuer, audience: issuer });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ERR_JWKS_NO_MATCHING_KEY" || code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED") {
        keySet = await fetchKeySet();
        return await jwtVerify(token, keySet, { issuer, audience: issuer });
      }
      throw err;
    }
  };

  const sessionAlive = async (sessionId: string): Promise<boolean> => {
    const res = await runSql(
      `SELECT 1 FROM auth_sessions WHERE tenant_id = $1 AND id = $2 AND "expiresAt" > now()`,
      [getTenantId(), sessionId],
    );
    return res.rows.length > 0;
  };

  const verifier: TokenVerifier = async (token) => {
    if (!token) return null;
    try {
      const { payload } = await verifyJwt(token);
      const uid = typeof payload.sub === "string" && payload.sub ? payload.sub : undefined;
      const sid = typeof payload.sid === "string" && payload.sid ? payload.sid : undefined;
      if (!uid || !sid) return null;
      if (!(await sessionAlive(sid))) return null;
      return { uid, token: { ...payload, admin: payload.admin === true } };
    } catch {
      // Any verification failure -> unauthenticated (host answers 401).
      return null;
    }
  };

  const provisionUser: SelfhostAuth["provisionUser"] = async (opts) => {
    const email = opts.email.trim().toLowerCase();
    // The user.create database hook enforces the invite gate for every
    // account path; checking here too keeps the error surfaced BEFORE any
    // adapter work and keeps this entry point self-documenting.
    await assertInvited(email);
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({
      ...(opts.uid ? { id: opts.uid } : {}),
      email,
      name: opts.displayName ?? email,
      // Provisioned, never self-registered: the invite IS the verification.
      emailVerified: true,
      ...(opts.admin ? { customClaims: JSON.stringify({ admin: true }) } : {}),
    });
    // No password -> no credential account (migrated users get a forced
    // reset in W2); with one, link a credential account like Better Auth's
    // own sign-up path does.
    if (opts.password !== undefined) {
      await ctx.internalAdapter.linkAccount({
        userId: user.id,
        providerId: "credential",
        accountId: user.id,
        password: await ctx.password.hash(opts.password),
      });
    }
    return { uid: user.id };
  };

  const signInEmail: SelfhostAuth["signInEmail"] = async (email, password) => {
    const res = await auth.api.signInEmail({
      body: { email: email.trim().toLowerCase(), password },
    });
    if (!res.token) {
      throw new Error("selfhost auth: sign-in produced no session token");
    }
    // Exchange the session for a JWKS-verifiable JWT (the bearer plugin
    // accepts the raw session token).
    const { token } = await auth.api.getToken({
      headers: new Headers({ authorization: `Bearer ${res.token}` }),
    });
    return { token };
  };

  return {
    handler: (req) => auth.handler(req),
    verifier,
    provisionUser,
    signInEmail,
  };
}
