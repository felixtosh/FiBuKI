/**
 * The settings screen's identity save, and the Partner detail panel's
 * "this is me" (#632). The browser only reads the identity document
 * (ADR-0016); this is how it writes it. Takes only identity fields, for the
 * caller's own document.
 */

import { createCallable } from "../utils/createCallable";
import { saveIdentity, type IdentityForm } from "./identity";

export const saveIdentityCallable = createCallable<IdentityForm, { success: true }>(
  { name: "saveIdentity" },
  async (ctx, request) => saveIdentity(ctx.db, ctx.userId, request ?? {})
);
