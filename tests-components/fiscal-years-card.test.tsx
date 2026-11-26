/**
 * #794: the Fiscal Years section says a server refusal in the User's language,
 * from the reason the refusal carries, and says "nothing changed" when a save
 * changed nothing instead of claiming a recorded change.
 */

import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import de from "@/messages/de.json";

const server = vi.hoisted(() => ({ update: null as null | (() => Promise<unknown>) }));
const SETTINGS = { startMonth: 1, trackedFrom: "2022-01", closedThrough: null };

vi.mock("@/lib/firebase/callable", () => ({
  callFunction: vi.fn(async (name: string) => {
    if (name === "getFiscalYears") return { settings: SETTINGS, changes: [] };
    return server.update!();
  }),
}));

import { FiscalYearsCard } from "@/components/settings/fiscal-years-card";

function renderCard(locale: "en" | "de") {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : de}>
      <FiscalYearsCard />
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  server.update = null;
});

describe("the Fiscal Years section", () => {
  it("says a refusal in German, naming the month the server gives", async () => {
    server.update = async () => {
      throw Object.assign(new Error("Tracked From cannot move to 2023-01: 2022-03 holds Transactions or Files"), {
        details: { reason: "tracked-from-holds-data", month: "2022-03" },
      });
    };
    renderCard("de");

    fireEvent.click(await screen.findByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/über 2022-03 hinaus/));
  });

  it("says nothing changed when the server wrote no record", async () => {
    server.update = async () => ({ settings: SETTINGS, record: null });
    renderCard("en");

    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Nothing changed."));
  });

  it("offers months from lists, not a free-text field", async () => {
    renderCard("en");
    await screen.findByRole("button", { name: "Save" });

    expect(document.querySelector('input[type="month"]')).toBeNull();
  });
});
