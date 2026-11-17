/**
 * A Cash Payment's own activity entries (#788, #790) read as words in the
 * activity log, in both languages, not as the raw type.
 */

import * as React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import de from "@/messages/de.json";
import { ActivityHistory } from "@/components/activity/activity-history";
import type { AutomationHistoryEntry } from "@/types/transaction";

const entries = [
  {
    type: "cash_payment_corrected",
    status: "completed",
    actor: "manual",
    summary: "Cash Payment corrected by hand: name \"Parkschien\" → \"Parkschein\"",
    ranAt: { toDate: () => new Date("2026-07-06T10:00:00Z") },
  },
] as unknown as AutomationHistoryEntry[];

describe("ActivityHistory on a corrected Cash Payment", () => {
  it("names the correction in English", () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ActivityHistory entries={entries} expandedByDefault />
      </NextIntlClientProvider>
    );
    expect(screen.getByText("Cash payment corrected")).toBeTruthy();
    expect(screen.queryByText("cash_payment_corrected")).toBeNull();
  });

  it("names the correction in German", () => {
    render(
      <NextIntlClientProvider locale="de" messages={de}>
        <ActivityHistory entries={entries} expandedByDefault />
      </NextIntlClientProvider>
    );
    expect(screen.getByText("Barzahlung korrigiert")).toBeTruthy();
  });
});
