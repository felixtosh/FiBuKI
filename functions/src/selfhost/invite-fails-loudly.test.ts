/**
 * #159 finding 4: invites must fail loudly when no mailer is configured.
 *
 * Before this, sendInviteNotification returned { success: true } while the
 * mailer shim logged "SMTP not configured … skipping email" and returned
 * false — the admin saw "Invitation sent" and the invite sat Pending forever.
 * The callable now refuses up front (failed-precondition) when the mailer is
 * unconfigured, and reports a send failure instead of swallowing it.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { __resetFirestoreShim } from "./firestore-shim";
import { _setTransportForTests } from "./mailer-shim";
import { createHost } from "./host";
import { sendInviteNotificationCallable } from "../auth/sendInviteNotificationCallable";

const ADMIN_TOKEN = "tok-admin";

const SMTP_ENV = ["FIBUKI_SMTP_HOST", "FIBUKI_SMTP_PORT", "FIBUKI_SMTP_USER", "FIBUKI_SMTP_PASS"];
let savedEnv: Record<string, string | undefined>;

let server: http.Server;
let base: string;

beforeAll(async () => {
  const host = createHost(
    { sendInviteNotification: sendInviteNotificationCallable },
    {
      verifyToken: async (t) =>
        t === ADMIN_TOKEN ? { uid: "admin-1", token: { admin: true, email: "admin@test.at" } } : null,
    },
  );
  server = http.createServer(host.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(async () => {
  savedEnv = Object.fromEntries(SMTP_ENV.map((k) => [k, process.env[k]]));
  for (const k of SMTP_ENV) delete process.env[k];
  _setTransportForTests(undefined);
  await __resetFirestoreShim();
});

afterEach(() => {
  for (const k of SMTP_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  _setTransportForTests(undefined);
});

async function invite(email: string) {
  const res = await fetch(`${base}/sendInviteNotification`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ data: { email } }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("sendInviteNotification without a configured mailer", () => {
  it("fails loudly instead of reporting success", async () => {
    const { status, body } = await invite("newuser@example.at");
    expect(status).toBe(400); // failed-precondition
    expect(body.error?.status).toBe("FAILED_PRECONDITION");
    // The message must tell the operator WHAT to configure.
    expect(String(body.error?.message)).toMatch(/SMTP|mailer/i);
  });
});

describe("sendInviteNotification with a working transport", () => {
  it("sends and reports success", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "m-1" });
    _setTransportForTests({ sendMail } as never);

    const { status, body } = await invite("newuser@example.at");
    expect(status).toBe(200);
    expect(body.result?.success).toBe(true);
    expect(sendMail).toHaveBeenCalledOnce();
    expect(sendMail.mock.calls[0][0].to).toBe("newuser@example.at");
  });

  it("surfaces a transport failure instead of swallowing it", async () => {
    const sendMail = vi.fn().mockRejectedValue(new Error("relay refused"));
    _setTransportForTests({ sendMail } as never);

    const { status, body } = await invite("newuser@example.at");
    expect(status).toBeGreaterThanOrEqual(400);
    expect(body.error?.message).toMatch(/not.*sent|failed/i);
  });
});
