/**
 * #805: FiBuKI asks before it brings in history. The CSV Import preview names
 * the rows before Tracked From per fiscal year and offers track as closed,
 * track as open (only while nothing is closed) and skip; first setup asks the
 * same question as a choice of fiscal years, the current one open by default.
 */

import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import de from "@/messages/de.json";

const server = vi.hoisted(() => ({
  hint: { count: 0, byFiscalYear: {} as Record<string, number> },
  calls: [] as string[],
}));

vi.mock("@/lib/firebase/callable", () => ({
  callFunction: vi.fn(async (name: string) => {
    server.calls.push(name);
    if (name === "getUntrackedFilesHint") return server.hint;
    return { dismissed: true };
  }),
}));

import { UntrackedImportChoice } from "@/components/import/untracked-import-choice";
import { FirstSetupFiscalYears } from "@/components/onboarding/first-setup-fiscal-years";
import { UntrackedFilesHint } from "@/components/files/untracked-files-hint";

beforeEach(() => {
  server.calls = [];
});

const PREVIEW = {
  untrackedCount: 312,
  untrackedByFiscalYear: { "2022": 200, "2023": 112 },
  choices: {
    closed: { trackedFrom: "2022-01", closedThrough: "2025-12" },
    open: { trackedFrom: "2022-01" },
  },
};

function inLocale(node: React.ReactNode, locale: "en" | "de" = "en") {
  return (
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : de}>
      {node}
    </NextIntlClientProvider>
  );
}

describe("the Import preview's question", () => {
  it("names the untracked rows per fiscal year and offers the three choices", () => {
    const onChange = vi.fn();
    render(inLocale(<UntrackedImportChoice preview={PREVIEW} value={null} onChange={onChange} />));

    expect(screen.getByText("312 rows from fiscal years 2022 and 2023, which you don't track")).toBeTruthy();
    const options = screen.getAllByRole("radio").map((r) => r.getAttribute("aria-label") ?? r.textContent);
    expect(options).toHaveLength(3);

    fireEvent.click(screen.getByRole("radio", { name: /Track them as closed/ }));
    expect(onChange).toHaveBeenCalledWith("closed");
    fireEvent.click(screen.getByRole("radio", { name: /Skip them/ }));
    expect(onChange).toHaveBeenCalledWith("skip");
  });

  it("does not offer track as open once something is closed", () => {
    const preview = { ...PREVIEW, choices: { ...PREVIEW.choices, open: null } };
    render(inLocale(<UntrackedImportChoice preview={preview} value={null} onChange={() => {}} />));

    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.queryByRole("radio", { name: /Track them as open/ })).toBeNull();
  });

  it("asks nothing when no row lies before Tracked From", () => {
    const preview = { untrackedCount: 0, untrackedByFiscalYear: {}, choices: { closed: null, open: null } };
    const { container } = render(inLocale(<UntrackedImportChoice preview={preview} value={null} onChange={() => {}} />));

    expect(container.textContent).toBe("");
  });

  it("asks in German too", () => {
    render(inLocale(<UntrackedImportChoice preview={PREVIEW} value={null} onChange={() => {}} />, "de"));

    expect(screen.getByText("312 Zeilen aus den Geschäftsjahren 2022 und 2023, die du nicht führst")).toBeTruthy();
  });
});

describe("the hint about documents before Tracked From", () => {
  it("names the count and fiscal year once, and dismissing it tells the server", async () => {
    server.hint = { count: 3, byFiscalYear: { "2021": 3 } };
    render(inLocale(<UntrackedFilesHint />));

    expect(await screen.findByText("3 documents from 2021, a year you don't track")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));

    expect(screen.queryByText(/documents from 2021/)).toBeNull();
    expect(server.calls).toContain("dismissUntrackedFilesHint");
  });

  it("shows nothing when there is nothing new to hint", async () => {
    server.hint = { count: 0, byFiscalYear: {} };
    const { container } = render(inLocale(<UntrackedFilesHint />));

    await waitFor(() => expect(server.calls).toContain("getUntrackedFilesHint"));
    expect(container.textContent).toBe("");
  });
});

describe("first setup asks which fiscal years to track", () => {
  it("offers the current fiscal year open and earlier ones untracked by default", () => {
    const onChange = vi.fn();
    render(inLocale(<FirstSetupFiscalYears today="2026-11-26" onChange={onChange} />));

    expect(screen.getByRole("radio", { name: "2026: Open" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "2025: Not tracked" }).getAttribute("aria-checked")).toBe("true");
    expect(onChange).toHaveBeenLastCalledWith({ startMonth: 1, trackedFrom: "2026-01", closedThrough: null });
  });

  it("the current fiscal year open is a default: closing it closes the tracked years before it, through this month", () => {
    const onChange = vi.fn();
    render(inLocale(<FirstSetupFiscalYears today="2026-11-26" onChange={onChange} />));
    fireEvent.click(screen.getByRole("radio", { name: "2025: Open" }));

    fireEvent.click(screen.getByRole("radio", { name: "2026: Closed" }));

    expect(screen.getByRole("radio", { name: "2025: Closed" }).getAttribute("aria-checked")).toBe("true");
    expect(onChange).toHaveBeenLastCalledWith({ startMonth: 1, trackedFrom: "2025-01", closedThrough: "2026-11" });
  });

  it("the current fiscal year is never untracked, and an earlier year open opens it again", () => {
    const onChange = vi.fn();
    render(inLocale(<FirstSetupFiscalYears today="2026-11-26" onChange={onChange} />));
    expect(screen.queryByRole("radio", { name: "2026: Not tracked" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "2026: Closed" }));

    fireEvent.click(screen.getByRole("radio", { name: "2025: Open" }));

    expect(screen.getByRole("radio", { name: "2026: Open" }).getAttribute("aria-checked")).toBe("true");
    expect(onChange).toHaveBeenLastCalledWith({ startMonth: 1, trackedFrom: "2025-01", closedThrough: null });
  });

  it("tracking an earlier year as closed closes it and tracks every year after it", () => {
    const onChange = vi.fn();
    render(inLocale(<FirstSetupFiscalYears today="2026-11-26" onChange={onChange} />));

    fireEvent.click(screen.getByRole("radio", { name: "2023: Closed" }));

    expect(screen.getByRole("radio", { name: "2024: Closed" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "2025: Closed" }).getAttribute("aria-checked")).toBe("true");
    expect(onChange).toHaveBeenLastCalledWith({ startMonth: 1, trackedFrom: "2023-01", closedThrough: "2025-12" });
  });

  it("an earlier year open opens every year after it, and keeps the closed ones before it", () => {
    const onChange = vi.fn();
    render(inLocale(<FirstSetupFiscalYears today="2026-11-26" onChange={onChange} />));

    fireEvent.click(screen.getByRole("radio", { name: "2022: Closed" }));
    fireEvent.click(screen.getByRole("radio", { name: "2024: Open" }));

    expect(screen.getByRole("radio", { name: "2023: Closed" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "2025: Open" }).getAttribute("aria-checked")).toBe("true");
    expect(onChange).toHaveBeenLastCalledWith({ startMonth: 1, trackedFrom: "2022-01", closedThrough: "2023-12" });
  });

  it("an untracked year leaves every year before it untracked", () => {
    const onChange = vi.fn();
    render(inLocale(<FirstSetupFiscalYears today="2026-11-26" onChange={onChange} />));

    fireEvent.click(screen.getByRole("radio", { name: "2022: Open" }));
    fireEvent.click(screen.getByRole("radio", { name: "2024: Not tracked" }));

    expect(screen.getByRole("radio", { name: "2022: Not tracked" }).getAttribute("aria-checked")).toBe("true");
    expect(onChange).toHaveBeenLastCalledWith({ startMonth: 1, trackedFrom: "2025-01", closedThrough: null });
  });

  it("names fiscal years that do not start in January by both their years", () => {
    const onChange = vi.fn();
    render(inLocale(<FirstSetupFiscalYears today="2026-03-10" onChange={onChange} startMonth={7} />));

    expect(screen.getByRole("radiogroup", { name: "2025/26" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "2024/25: Closed" }));
    expect(onChange).toHaveBeenLastCalledWith({ startMonth: 7, trackedFrom: "2024-07", closedThrough: "2025-06" });
  });
});
