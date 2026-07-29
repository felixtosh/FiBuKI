/**
 * LIVE integration test for ImapProvider against a real IMAP server.
 *
 * Skipped by default. Exercises the real network path (no mocks) against a
 * real IMAP server. Enable with:
 *
 *   IMAP_LIVE=1 IMAP_HOST=<host> IMAP_USER=<user> IMAP_PASS=<app-pw> \
 *     npx vitest run src/mail/imap/ImapProvider.live.test.ts --pool=forks --maxWorkers=1
 *
 * Env: IMAP_HOST, IMAP_PORT (993), IMAP_USER, IMAP_PASS, IMAP_MAILBOX (INBOX),
 * IMAP_ALLOW_SELF_SIGNED (default true — for internal/dev servers).
 *
 * Read-only by design (EXAMINE): this never writes to the mailbox. Safe to run
 * against a production maildir.
 */

import { describe, it, expect } from "vitest";
import { ImapProvider } from "./ImapProvider";

const LIVE = process.env.IMAP_LIVE === "1" && !!process.env.IMAP_HOST && !!process.env.IMAP_USER;

describe.skipIf(!LIVE)("ImapProvider (live IMAP server)", () => {
  const config = {
    host: process.env.IMAP_HOST || "",
    port: Number(process.env.IMAP_PORT || "993"),
    secure: true,
    allowSelfSigned: process.env.IMAP_ALLOW_SELF_SIGNED !== "false",
    mailbox: process.env.IMAP_MAILBOX || "INBOX",
    keywordPrefilter: false, // exhaustive: don't let weak substring matching hide messages
    user: process.env.IMAP_USER || "",
    password: process.env.IMAP_PASS || "",
  };

  it("connects, searches a wide window, fetches a message (+ attachment if any)", async () => {
    const provider = new ImapProvider(config);
    try {
      const page = await provider.search({
        dateFrom: new Date("2000-01-01T00:00:00Z"),
        dateTo: new Date(),
      });
      console.log(`[live] search returned ${page.messages.length} refs, nextPageToken=${page.nextPageToken ?? "none"}`);
      expect(page.messages.length).toBeGreaterThan(0);

      // Walk up to a handful of messages looking for an invoice-type attachment.
      let sampled = 0;
      let withAttachment = 0;
      for (const ref of page.messages.slice(0, 10)) {
        const msg = await provider.getMessage(ref);
        sampled++;
        expect(typeof msg.subject).toBe("string");
        expect(msg.date instanceof Date).toBe(true);
        if (msg.attachments.length > 0) {
          withAttachment++;
          const bytes = await provider.getAttachment(msg, msg.attachments[0]);
          expect(bytes.length).toBeGreaterThan(0);
          console.log(
            `[live] "${msg.subject}" attach="${msg.attachments[0].filename}" (${msg.attachments[0].mimeType}) → ${bytes.length} bytes`
          );
          break;
        }
      }
      console.log(`[live] sampled ${sampled} messages, ${withAttachment} with invoice attachment`);
    } finally {
      await provider.close();
    }
  }, 60000);

  it("paginates deterministically (page 2 UIDs strictly below page 1 cursor)", async () => {
    const provider = new ImapProvider(config);
    try {
      const first = await provider.search({
        dateFrom: new Date("2000-01-01T00:00:00Z"),
        dateTo: new Date(),
      });
      if (!first.nextPageToken) {
        console.log("[live] only one page; pagination assertion skipped");
        return;
      }
      const second = await provider.search({
        dateFrom: new Date("2000-01-01T00:00:00Z"),
        dateTo: new Date(),
        pageToken: first.nextPageToken,
      });
      const cursor = Number(first.nextPageToken);
      for (const ref of second.messages) {
        expect(Number(ref.id)).toBeLessThan(cursor);
      }
      console.log(`[live] page1=${first.messages.length} cursor=${cursor} page2=${second.messages.length}`);
    } finally {
      await provider.close();
    }
  }, 60000);
});
