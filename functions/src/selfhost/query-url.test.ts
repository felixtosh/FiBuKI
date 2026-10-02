/**
 * Selecting a row must not cost a Next.js navigation (a server round trip of
 * about 600ms on fibuki.com) nor re-filter the list.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { pushQuery, replaceQuery } from "../../../lib/navigation/query-url";
import { filterQueryKey } from "../../../lib/filters/url-params";

describe("pushQuery / replaceQuery", () => {
  const history = { pushState: vi.fn(), replaceState: vi.fn() };
  const router = { push: vi.fn(), replace: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("window", {
      location: { href: "https://fibuki.test/transactions?search=rewe", pathname: "/transactions" },
      history,
    });
  });

  it("changes a same-page query through the history API, never the router", () => {
    pushQuery(router, "/transactions?search=rewe&id=tx1");
    replaceQuery(router, "/transactions?search=rewe");
    expect(history.pushState).toHaveBeenCalledWith(null, "", "/transactions?search=rewe&id=tx1");
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/transactions?search=rewe");
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("hands a different page to the router", () => {
    pushQuery(router, "/files?id=f1");
    expect(router.push).toHaveBeenCalledWith("/files?id=f1", { scroll: false });
    expect(history.pushState).not.toHaveBeenCalled();
  });
});

describe("filterQueryKey", () => {
  it("ignores the selected row and the overlay, and parameter order", () => {
    const a = filterQueryKey(new URLSearchParams("search=rewe&type=expense&id=tx1&connect=true"));
    const b = filterQueryKey(new URLSearchParams("type=expense&search=rewe&id=tx2"));
    expect(a).toBe(b);
    expect(a).not.toContain("id=");
  });

  it("changes when a filter changes", () => {
    expect(filterQueryKey(new URLSearchParams("search=rewe"))).not.toBe(
      filterQueryKey(new URLSearchParams("search=billa")),
    );
  });
});
