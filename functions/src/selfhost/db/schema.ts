/**
 * Drizzle schema — the authoritative shape of the selfhost Postgres database.
 * Migrations are generated from this file (readable SQL under
 * functions/drizzle/) with:
 *
 *   npx drizzle-kit generate --name <slug>
 *
 * then applied at boot by db/migrate.ts through the shim's SqlClient, so the
 * exact same DDL runs against embedded PGlite (tests) and real Postgres
 * (compose / production).
 *
 * Multi-tenancy (docs/rewrite-goals.md §Multi-tenancy): shared schema,
 * tenant_id on EVERY table, the API layer enforces, RLS as backstop.
 * Self-host is multi-tenant with exactly one tenant — no special case.
 *
 * NOTE on RLS: drizzle-kit does not emit ENABLE/FORCE ROW LEVEL SECURITY or
 * CREATE POLICY, so every new table's migration gets a hand-appended RLS
 * block — copy the pattern at the bottom of drizzle/0000_init.sql. FORCE is
 * required: tests and the selfhost deployment connect as the table owner,
 * and without FORCE the owner bypasses policies entirely.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { FLATTENED, FlatKind, generatedColumnExpr } from "./collections";

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The JSONB bridge table: every collection that has NOT yet been flattened
 * lives here, exactly as the Phase-0 shim stored it (plus tenant_id). It
 * shrinks collection by collection and is deleted when the last one leaves.
 */
export const docs = pgTable(
  "docs",
  {
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    path: text("path").notNull(),
    collection_path: text("collection_path").notNull(),
    id: text("id").notNull(),
    data: jsonb("data").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.path] }),
    index("docs_tenant_collection_idx").on(t.tenant_id, t.collection_path),
  ],
);

function generatedColumn(kind: FlatKind, col: string, fieldPath: string) {
  const expr = sql.raw(generatedColumnExpr(fieldPath, kind));
  switch (kind) {
    case "text":
      return text(col).generatedAlwaysAs(expr);
    case "boolean":
      return boolean(col).generatedAlwaysAs(expr);
    case "number":
      return doublePrecision(col).generatedAlwaysAs(expr);
    case "timestamp":
      return timestamp(col, { withTimezone: true }).generatedAlwaysAs(expr);
  }
}

/**
 * Build a flattened-collection table from its spec in collections.ts:
 * (tenant_id, id) PK, canonical `data` JSONB payload, and one STORED
 * GENERATED column per queried field. Keys are the SQL column names so the
 * spec's index tuples resolve directly.
 */
function flatTable(collection: string) {
  const spec = FLATTENED[collection];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cols: Record<string, any> = {
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    id: text("id").notNull(),
    data: jsonb("data").notNull(),
  };
  for (const [fieldPath, f] of Object.entries(spec.fields)) {
    cols[f.col] = generatedColumn(f.kind, f.col, fieldPath);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return pgTable(spec.table, cols, (t: Record<string, any>) => [
    primaryKey({ columns: [t.tenant_id, t.id] }),
    ...spec.indexes.map((tuple) => {
      const [first, ...rest] = tuple.map((c) => t[c]);
      return index(`${spec.table}_${tuple.join("_")}_idx`).on(first, ...rest);
    }),
  ]);
}

export const sources = flatTable("sources");
export const transactions = flatTable("transactions");
export const files = flatTable("files");
export const partners = flatTable("partners");
export const fileConnections = flatTable("fileConnections");

// ---------------------------------------------------------------------------
// Better Auth store (W1). Tables are prefixed auth_ to keep the identity
// plane visually separate from domain data. Columns keep Better Auth's
// DEFAULT camelCase field names (quoted identifiers) instead of this file's
// snake_case convention — the selfhost adapter (../better-auth.ts) then
// needs zero field-name mapping against the library's schema, which is one
// whole class of translation bugs that cannot exist. Every table still
// carries tenant_id + RLS like all tenant data; uniques are per-tenant.
// Cross-table FKs are deliberately absent: Better Auth maintains
// referential integrity in application code (deleteUser removes sessions
// and accounts itself), and composite-PK FKs would fight its single-column
// id model.
// ---------------------------------------------------------------------------

/** Shared (tenant_id, id) base for every Better Auth table. */
function authCols() {
  return {
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    id: text("id").notNull(),
  };
}

export const authUsers = pgTable(
  "auth_users",
  {
    ...authCols(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("emailVerified").notNull(),
    image: text("image"),
    // firebase-admin custom-claims port (setCustomUserClaims / token claims),
    // stored as a JSON string the way Better Auth serializes JSON fields.
    customClaims: text("customClaims"),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.id] }),
    unique("auth_users_tenant_email_uq").on(t.tenant_id, t.email),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    ...authCols(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    token: text("token").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    userId: text("userId").notNull(),
    activeOrganizationId: text("activeOrganizationId"),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.id] }),
    unique("auth_sessions_tenant_token_uq").on(t.tenant_id, t.token),
    index("auth_sessions_tenant_user_idx").on(t.tenant_id, t.userId),
  ],
);

export const authAccounts = pgTable(
  "auth_accounts",
  {
    ...authCols(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    userId: text("userId").notNull(),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: timestamp("accessTokenExpiresAt", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.id] }),
    index("auth_accounts_tenant_user_idx").on(t.tenant_id, t.userId),
  ],
);

export const authVerifications = pgTable(
  "auth_verifications",
  {
    ...authCols(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.id] }),
    index("auth_verifications_tenant_identifier_idx").on(t.tenant_id, t.identifier),
  ],
);

export const authOrganizations = pgTable(
  "auth_organizations",
  {
    ...authCols(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    logo: text("logo"),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    metadata: text("metadata"),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.id] }),
    unique("auth_organizations_tenant_slug_uq").on(t.tenant_id, t.slug),
  ],
);

export const authMembers = pgTable(
  "auth_members",
  {
    ...authCols(),
    organizationId: text("organizationId").notNull(),
    userId: text("userId").notNull(),
    role: text("role").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.id] }),
    index("auth_members_tenant_org_idx").on(t.tenant_id, t.organizationId),
    index("auth_members_tenant_user_idx").on(t.tenant_id, t.userId),
  ],
);

export const authInvitations = pgTable(
  "auth_invitations",
  {
    ...authCols(),
    organizationId: text("organizationId").notNull(),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").notNull(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    inviterId: text("inviterId").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.id] }),
    index("auth_invitations_tenant_org_idx").on(t.tenant_id, t.organizationId),
  ],
);

export const authJwks = pgTable(
  "auth_jwks",
  {
    ...authCols(),
    publicKey: text("publicKey").notNull(),
    privateKey: text("privateKey").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.tenant_id, t.id] })],
);
