/**
 * #794: rows an Import or a bank sync skips because they lie before Tracked
 * From are shown, per fiscal year, on the CSV Import's result and after a
 * sync, instead of vanishing silently.
 */

import * as React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import de from "@/messages/de.json";
import { ImportProgress } from "@/components/import/import-progress";
import { UntrackedNotice } from "@/components/import/untracked-notice";

const results = {
  total: 5,
  imported: 2,
  skipped: 0,
  errors: 0,
  errorDetails: [],
  untrackedByFiscalYear: { "2022": 1, "2023": 2 },
};

describe("the CSV Import result names the untracked rows", () => {
  it("counts them per fiscal year, newest first, and links to the settings", () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ImportProgress progress={100} results={results} isComplete />
      </NextIntlClientProvider>
    );

    expect(screen.getByText("3 rows were skipped: dated before Tracked From")).toBeTruthy();
    expect(screen.getByText("2023: 2, 2022: 1")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Fiscal Years/ }).getAttribute("href")).toBe("/settings/fiscal-years");
  });

  it("says it in German", () => {
    render(
      <NextIntlClientProvider locale="de" messages={de}>
        <UntrackedNotice byFiscalYear={{ "2023/24": 1 }} />
      </NextIntlClientProvider>
    );

    expect(screen.getByText(/1 Zeile wurde übersprungen/)).toBeTruthy();
  });

  it("shows nothing when nothing was skipped", () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={en}>
        <UntrackedNotice byFiscalYear={{}} />
      </NextIntlClientProvider>
    );
    expect(container.textContent).toBe("");
  });
});
