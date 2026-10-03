/**
 * #555: an invoice email for a foreign-currency charge states the charge in
 * its own currency. The bank line is EUR 21,76; the OpenAI email says
 * "$24.00". The scorer looks for both figures.
 */

import { describe, it, expect } from "vitest";
import { scoreAttachmentMatch } from "../scoreAttachmentMatch";

const AMOUNT_REASON = "Amount appears in email or filename";

const email = (body: string) => ({
  filename: "invoice.pdf",
  mimeType: "application/pdf",
  emailSubject: "Your receipt",
  emailBodyText: body,
  transactionAmount: -2176,
});

describe("the email scorer's amount check", () => {
  it("finds the bank-stated original amount in the email text", () => {
    const result = scoreAttachmentMatch({
      ...email("Amount paid: $24.00"),
      transactionOriginalAmount: 2400,
    });
    expect(result.reasons).toContain(AMOUNT_REASON);
  });

  it("does not find it without the original amount", () => {
    const result = scoreAttachmentMatch(email("Amount paid: $24.00"));
    expect(result.reasons).not.toContain(AMOUNT_REASON);
  });

  it("still finds the bank's own EUR figure", () => {
    const result = scoreAttachmentMatch({
      ...email("Betrag: 21,76 EUR"),
      transactionOriginalAmount: 2400,
    });
    expect(result.reasons).toContain(AMOUNT_REASON);
  });
});
