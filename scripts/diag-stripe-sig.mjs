/**
 * Isolate WHY the webhook rejects a correctly signed request: wrong secret, or a
 * request body that is not the bytes that were signed.
 *
 * Run inside the api container so it uses the same stripe library, the same
 * process.env, and no network in between.
 */

import crypto from "node:crypto";
import Stripe from "stripe";

const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
const raw = JSON.stringify({ id: "evt_diag", object: "event", type: "ping.diag", data: { object: {} } });
const ts = Math.floor(Date.now() / 1000);
const sig = crypto
  .createHmac("sha256", secret)
  .update(`${ts}.${raw}`, "utf8")
  .digest("hex");
const header = `t=${ts},v1=${sig}`;

console.log(`  secret in env: ${secret.slice(0, 14)}... (len ${secret.length})`);

// 1) Library + secret in isolation. If this throws, the secret is the problem.
try {
  Stripe.webhooks.constructEvent(Buffer.from(raw, "utf8"), header, secret);
  console.log("  [1] constructEvent with a Buffer of the signed bytes: PASS");
} catch (e) {
  console.log(`  [1] constructEvent with a Buffer of the signed bytes: FAIL — ${e.message.split("\n")[0]}`);
}

// 2) The failure mode where a parsed body is re-serialised before verification.
//    Byte-identical here only by luck of key order; the point is to show the shape.
try {
  Stripe.webhooks.constructEvent(JSON.stringify(JSON.parse(raw)), header, secret);
  console.log("  [2] constructEvent with a RE-SERIALISED body: PASS (would mask the bug)");
} catch (e) {
  console.log(`  [2] constructEvent with a RE-SERIALISED body: FAIL — ${e.message.split("\n")[0]}`);
}

// 3) What the handler would see if rawBody were missing entirely.
try {
  Stripe.webhooks.constructEvent(undefined, header, secret);
  console.log("  [3] constructEvent with undefined rawBody: PASS (impossible)");
} catch (e) {
  console.log(`  [3] constructEvent with undefined rawBody: FAIL — ${e.message.split("\n")[0]}`);
}
