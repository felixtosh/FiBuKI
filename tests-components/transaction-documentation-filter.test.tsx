/**
 * #249 gave the Transactions list a Documentation State chip; #526 removed it
 * again, since the Files chip (Assigned / Unassigned) asks the same question
 * by column. The pure matching helpers stay, and an old link's
 * `documentation=` is ignored rather than applied invisibly.
 */

import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "@/messages/en.json";

vi.mock("@/hooks/use-document-label", () => ({
  useDocumentLabel: () => (presentation: { label?: string }) => presentation.label ?? "",
}));

import {
  ALL_DOCUMENTATION_STATES,
  matchesDocumentationStates,
  normalizeDocumentationStates,
} from "@/lib/filters/documentation-state-filter";
import { buildSearchParamsString, parseFiltersFromUrl } from "@/lib/filters/url-params";
import { TransactionToolbar } from "@/components/transactions/transaction-toolbar";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DocumentationState, TransactionFilters } from "@/types/transaction";

describe("matchesDocumentationStates", () => {
  it("lets everything through when no selection is set (the default)", () => {
    for (const state of ALL_DOCUMENTATION_STATES) {
      expect(matchesDocumentationStates(state, undefined)).toBe(true);
    }
    expect(matchesDocumentationStates(undefined, undefined)).toBe(true);
  });

  it.each(ALL_DOCUMENTATION_STATES)("unchecking %s removes exactly those rows", (removed) => {
    const selected = ALL_DOCUMENTATION_STATES.filter((s) => s !== removed);
    for (const state of ALL_DOCUMENTATION_STATES) {
      expect(matchesDocumentationStates(state, selected)).toBe(state !== removed);
    }
  });

  it("reads an absent state as unknown, the way the badge does", () => {
    expect(matchesDocumentationStates(undefined, ["unknown"])).toBe(true);
    expect(matchesDocumentationStates(null, ["undocumented"])).toBe(false);
  });

  it("a multi-value selection: receipt-only and unknown, nothing else", () => {
    const selected: DocumentationState[] = ["receipt-only", "unknown"];
    expect(matchesDocumentationStates("receipt-only", selected)).toBe(true);
    expect(matchesDocumentationStates("unknown", selected)).toBe(true);
    expect(matchesDocumentationStates("invoice", selected)).toBe(false);
    expect(matchesDocumentationStates("no-receipt-category", selected)).toBe(false);
    expect(matchesDocumentationStates("undocumented", selected)).toBe(false);
  });

  it("an empty selection shows nothing", () => {
    for (const state of ALL_DOCUMENTATION_STATES) {
      expect(matchesDocumentationStates(state, [])).toBe(false);
    }
  });
});

describe("normalizeDocumentationStates", () => {
  it("all five selected is the default, not a filter", () => {
    expect(normalizeDocumentationStates([...ALL_DOCUMENTATION_STATES])).toBeUndefined();
  });

  it("drops unknown values and duplicates, keeps canonical order", () => {
    expect(
      normalizeDocumentationStates(["unknown", "bogus", "invoice", "invoice"] as DocumentationState[])
    ).toEqual(["invoice", "unknown"]);
  });
});

describe("Documentation filter in the URL", () => {
  it("ignores an old documentation= link now that the chip is gone (#526)", () => {
    const filters = parseFiltersFromUrl(new URLSearchParams("documentation=receipt-only,unknown"));
    expect(filters.documentationStates).toBeUndefined();
    expect(buildSearchParamsString(filters, "")).toBe("");
  });
});

describe("Transactions toolbar", () => {
  function renderToolbar(filters: TransactionFilters, onFiltersChange = vi.fn()) {
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="Europe/Vienna">
        <TooltipProvider>
          <TransactionToolbar
            searchValue=""
            onSearchChange={() => {}}
            filters={filters}
            onFiltersChange={onFiltersChange}
          />
        </TooltipProvider>
      </NextIntlClientProvider>
    );
    return onFiltersChange;
  }

  it("has no Documentation chip any more (#526)", () => {
    renderToolbar({});
    expect(screen.queryByRole("button", { name: /Documentation/ })).toBeNull();
  });

  it("names the assigned/unassigned chip after the File column (#519)", () => {
    renderToolbar({});
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    for (const name of ["All", "Assigned", "Unassigned"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });
});
