/**
 * #249: the Transactions list can be filtered by Documentation State.
 *
 * A multi-select chip, every state selected by default, so the useful
 * questions (which are often exclusions) can be asked of the list. The filter
 * round-trips through the URL, counts as an active filter and is reset with
 * the others.
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
import {
  buildFilterUrl,
  buildSearchParamsString,
  countActiveFilters,
  hasActiveFilters,
  hasUrlParams,
  parseFiltersFromUrl,
} from "@/lib/filters/url-params";
import { describeDocumentationState } from "@/lib/documents/document-type-presentation";
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
  const roundTrip = (query: string) => {
    const filters = parseFiltersFromUrl(new URLSearchParams(query));
    return { filters, query: buildSearchParamsString(filters, "") };
  };

  it("round-trips a selection", () => {
    const { filters, query } = roundTrip("documentation=receipt-only,unknown");
    expect(filters.documentationStates).toEqual(["receipt-only", "unknown"]);
    expect(decodeURIComponent(query)).toBe("documentation=receipt-only,unknown");
    expect(decodeURIComponent(buildFilterUrl("/transactions", filters))).toBe(
      "/transactions?documentation=receipt-only,unknown"
    );
  });

  it("round-trips the empty selection", () => {
    const { filters, query } = roundTrip("documentation=");
    expect(filters.documentationStates).toEqual([]);
    expect(query).toBe("documentation=");
  });

  it("the default stays out of the URL", () => {
    const { filters, query } = roundTrip("");
    expect(filters.documentationStates).toBeUndefined();
    expect(query).toBe("");
  });

  it("counts as a URL param, an active filter, and is reset by clear-all", () => {
    expect(hasUrlParams(new URLSearchParams("documentation=invoice"))).toBe(true);
    const filters: TransactionFilters = { documentationStates: ["invoice"] };
    expect(hasActiveFilters(filters)).toBe(true);
    expect(countActiveFilters(filters)).toBe(1);
    expect(countActiveFilters({ ...filters, isComplete: true })).toBe(2);
    // clear-all resets to `{ search }`.
    expect(countActiveFilters({ search: filters.search })).toBe(0);
  });
});

describe("Documentation chip on the toolbar", () => {
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

  const labels = ALL_DOCUMENTATION_STATES.map((s) => describeDocumentationState(s).label);

  it("lists all five states, with the badge's labels, all checked by default", () => {
    renderToolbar({});
    fireEvent.click(screen.getByRole("button", { name: /Documentation/ }));
    for (const label of labels) {
      const option = screen.getByRole("menuitemcheckbox", { name: label });
      expect(option.getAttribute("aria-checked")).toBe("true");
    }
  });

  it("unchecking a value narrows the selection to the other four", () => {
    const onFiltersChange = renderToolbar({});
    fireEvent.click(screen.getByRole("button", { name: /Documentation/ }));
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: describeDocumentationState("invoice").label })
    );
    expect(onFiltersChange).toHaveBeenCalledWith({
      documentationStates: ["receipt-only", "no-receipt-category", "undocumented", "unknown"],
    });
  });

  it("rechecking the last value returns to the default", () => {
    const onFiltersChange = renderToolbar({
      documentationStates: ["invoice", "receipt-only", "no-receipt-category", "undocumented"],
    });
    fireEvent.click(screen.getByRole("button", { name: /Documentation/ }));
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: describeDocumentationState("unknown").label })
    );
    expect(onFiltersChange).toHaveBeenCalledWith({ documentationStates: undefined });
  });

  it("leaves the Status chip as it was", () => {
    renderToolbar({});
    fireEvent.click(screen.getByRole("button", { name: "Status" }));
    for (const name of ["All", "Assigned", "Unassigned"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });
});
