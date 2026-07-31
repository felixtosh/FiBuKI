/**
 * Prove the Stripe webhook verifies a genuine signature, end to end, against the
 * running API.
 *
 * Worth doing rather than trusting a 400-on-unsigned: the common way this endpoint
 * breaks is a JSON body parser that reads and re-serialises the request before
 * verification runs. Stripe signs the RAW bytes, so re-serialisation changes them
 * and every real delivery fails signature verification while the endpoint looks
 * perfectly healthy in the dashboard. Rejecting unsigned requests does not
 * distinguish that case from a working one; only a correctly signed request does.
 *
 * Sends an UNHANDLED event type on purpose. A handled one would write real billing
 * state on an sk_live account just to test plumbing.
 *
 *   node scripts/verify-stripe-webhook.mjs <url> <whsec_...>
 */

import crypto from "node:crypto";

const [, , url, secret] = process.argv;
if (!url || !secret?.startsWith("whsec_")) {
  console.error("usage: node verify-stripe-webhook.mjs <url> <whsec_...>");
  process.exit(1);
}

// Exactly the scheme Stripe uses: HMAC-SHA256 over `${timestamp}.${rawBody}`,
// keyed with the signing secret VERBATIM, INCLUDING the `whsec_` prefix.
// Stripping the prefix looks reasonable (it reads like a label) and makes every
// signature mismatch, which is indistinguishable from a broken endpoint.
function sign(raw, ts, whsec) {
  return crypto
    .createHmac("sha256", whsec)
    .update(`${ts}.${raw}`, "utf8")
    .digest("hex");
}

async function post(raw, header) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": header },
    body: raw,
  });
  return { status: res.status, body: (await res.text()).slice(0, 160) };
}

const raw = JSON.stringify({
  id: `evt_selftest_${Date.now()}`,
  object: "event",
  api_version: "2024-06-20",
  type: "ping.selftest", // not in the handled set; verified then ignored
  data: { object: {} },
});
const ts = Math.floor(Date.now() / 1000);

const good = await post(raw, `t=${ts},v1=${sign(raw, ts, secret)}`);
const bad = await post(raw, `t=${ts},v1=${"0".repeat(64)}`);
// A valid signature over a DIFFERENT body: catches "verifies the header but not
// against this request", which a naive implementation can still pass.
const tampered = await post(
  raw.replace("ping.selftest", "invoice.paid"),
  `t=${ts},v1=${sign(raw, ts, secret)}`,
);

console.log(`  valid signature    -> ${good.status}  ${good.body}`);
console.log(`  invalid signature  -> ${bad.status}  ${bad.body}`);
console.log(`  tampered body      -> ${tampered.status}  ${tampered.body}`);

const ok = good.status >= 200 && good.status < 300 && bad.status === 400 && tampered.status === 400;
console.log(
  ok
    ? "\n  PASS — genuine deliveries are accepted, forged and tampered ones are not."
    : "\n  FAIL — a real Stripe delivery would not be processed correctly.",
);
process.exit(ok ? 0 : 1);
