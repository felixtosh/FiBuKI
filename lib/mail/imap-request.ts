/**
 * Request bodies for the IMAP connect and credential-repair routes.
 *
 * These routes take a host, a mailbox name and a password from the caller and
 * then do something sensitive with them: open a live IMAP session and store an
 * encrypted credential. Identity is established before any of that, and
 * ownership is checked separately — but the *shape* of the body used to be
 * checked with `if (!host || !user || !password) return 400`, which puts a
 * user-controlled value in a condition guarding the sensitive action. CodeQL
 * flags that as `js/user-controlled-bypass`, and while the authorisation is
 * elsewhere and correct, the pattern is worth removing rather than arguing
 * with: a route should not hand-roll the difference between "absent",
 * "present but empty" and "present but the wrong type".
 *
 * So the body is parsed, not inspected. A body that does not match the schema
 * never reaches the route's logic; it raises `InvalidRequestBody`, which the
 * route's existing catch turns into a 400. Nothing branches on the caller's
 * values on the way in, and every value the route uses afterwards is typed,
 * trimmed and defaulted.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

/** A body that does not match its schema. Carries what was wrong, per field. */
export class InvalidRequestBody extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super("Invalid request body");
    this.name = "InvalidRequestBody";
    this.issues = issues;
  }
}

/** A stored mailbox that cannot be repaired because its settings are incomplete. */
export class IncompleteMailbox extends Error {
  constructor() {
    super("This mailbox is missing its connection settings. Reconnect it instead.");
    this.name = "IncompleteMailbox";
  }
}

const required = z.string().trim().min(1);
const port = z.number().int().min(1).max(65535);

/** POST /api/mail/imap/connect */
export const connectBodySchema = z.object({
  host: required,
  user: required,
  password: z.string().min(1),
  port: port.default(993),
  secure: z.boolean().default(true),
  mailbox: required.default("INBOX"),
  allowSelfSigned: z.boolean().default(false),
  keywordPrefilter: z.boolean().default(true),
});

/**
 * PATCH /api/mail/imap/credentials
 *
 * Everything but the password is optional: a repair usually changes only the
 * password, and an omitted field means "keep what the mailbox already stores",
 * never "reset to the default".
 */
export const credentialsBodySchema = z.object({
  integrationId: required,
  password: z.string().min(1),
  host: required.optional(),
  port: port.optional(),
  secure: z.boolean().optional(),
  mailbox: required.optional(),
  allowSelfSigned: z.boolean().optional(),
});

/** Parse a request body, or raise InvalidRequestBody. Never returns a partial value. */
export async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new InvalidRequestBody(["body: expected JSON"]);
  }

  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;

  throw new InvalidRequestBody(
    parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
  );
}

/**
 * Turn a body/mailbox error into its response, or null if it is neither.
 *
 * Call it first in a route's catch, next to the unauthorized check.
 */
export function invalidRequestResponse(error: unknown): NextResponse | null {
  if (error instanceof InvalidRequestBody) {
    return NextResponse.json({ error: error.message, issues: error.issues }, { status: 400 });
  }
  if (error instanceof IncompleteMailbox) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return null;
}
