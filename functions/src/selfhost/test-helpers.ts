/**
 * Shared helpers for selfhost shim tests.
 */

import { drainTriggers } from "./trigger-shim";

/**
 * Poll until cond() holds, draining trigger queues between checks. Needed
 * for fire-and-forget branches (reconciliation, receipt search, usage
 * logging) that application handlers intentionally do not await.
 */
export async function waitFor(cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    await drainTriggers();
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}
