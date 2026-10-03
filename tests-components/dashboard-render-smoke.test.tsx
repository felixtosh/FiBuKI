/**
 * Render smoke tests for the main dashboard pages.
 *
 * Why this exists
 * ---------------
 * PR #365 added a <Tooltip> to components/transactions/transaction-toolbar.tsx.
 * The toolbar renders outside the TooltipProvider inside transaction-table.tsx,
 * and no page-level provider existed, so /transactions threw "Tooltip must be
 * used within TooltipProvider" on every load in production until #366 wrapped
 * app/(dashboard)/layout.tsx in one. Typecheck, lint and build all passed: the
 * failure only exists at render time, inside the real provider tree.
 *
 * So these tests render each page the way Next does: root providers
 * (ThemeProvider, NextIntlClientProvider with the real messages), then the REAL
 * dashboard layout and template, then the page. Anything that throws while
 * rendering fails the test. They do not assert behaviour; that is the point.
 * Each case does assert one piece of the page body, though: a page that renders
 * null (a feature guard, a stuck Suspense) throws nothing and would pass empty.
 * Keep them cheap to run, and add a page here when it gets its own route.
 *
 * What is mocked, and why that is the smallest cut
 * ------------------------------------------------
 * - Auth: useAuth() returns a signed-in user. The real AuthProvider talks to
 *   Firebase Auth; ProtectedRoute and everything below it stay real.
 * - Firebase I/O: the SDK is initialised for real (it makes no network call
 *   until something subscribes), and only the calls that would reach the
 *   network are replaced, each answering "no documents". Queries, refs and
 *   every hook built on them run unmodified.
 * - Next runtime: next/navigation, next/link and next/font have no app-router
 *   context under jsdom.
 * - Browser APIs jsdom lacks (ResizeObserver, matchMedia, ...) are stubbed in
 *   setup.ts.
 *
 * Apart from useAuth, nothing in components/ or app/ is mocked (react-pdf is a
 * library). That is what makes the TooltipProvider regression visible: remove
 * it from the layout and the Transactions test fails.
 *
 * Known limit: jsdom has no layout, so the virtualised table renders its
 * header but no body rows. A throw inside a row cell is not caught here.
 */

import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

// --- Next runtime -----------------------------------------------------------

const nav = vi.hoisted(() => ({ pathname: "/transactions" }));

// Single docs by path; every other doc is missing. Files and Partners sit
// behind SmartFeatureGuard, which renders null on the default "free" plan, so
// the cases run on Smart unless they say otherwise (see beforeEach); without
// it those two pages would pass with nothing rendered.
const SMART_SUBSCRIPTION = { plan: "smart", status: "active" };
const docFixtures = vi.hoisted(() => ({}) as Record<string, Record<string, unknown>>);

vi.mock("next/navigation", () => {
  const router = {
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  };
  return {
    useRouter: () => router,
    usePathname: () => nav.pathname,
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({}),
    useSelectedLayoutSegment: () => null,
    useSelectedLayoutSegments: () => [],
    redirect: vi.fn(),
    notFound: vi.fn(),
  };
});

vi.mock("next/link", () => ({
  default: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: unknown; prefetch?: unknown }>(
    function Link({ href, prefetch: _prefetch, ...rest }, ref) {
      return <a ref={ref} href={typeof href === "string" ? href : "#"} {...rest} />;
    }
  ),
}));

vi.mock("next/font/google", () => {
  const font = () => ({ className: "", variable: "", style: {} });
  return { Figtree: font, DynaPuff: font };
});

// pdfjs (behind react-pdf) needs DOMMatrix and a worker at import time; jsdom
// has neither. The PDF viewer only mounts once a file is opened anyway.
vi.mock("react-pdf", () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));

// --- Auth -------------------------------------------------------------------

vi.mock("@/components/auth/auth-provider", () => {
  const user = { uid: "smoke-user", email: "smoke@example.com", displayName: "Smoke Test" };
  const value = {
    user,
    userId: user.uid,
    isAdmin: false,
    loading: false,
    signIn: vi.fn(),
    signInWithGoogle: vi.fn(),
    signInWithGitHub: vi.fn(),
    signOut: vi.fn(),
    resetPassword: vi.fn(),
    refreshAdminStatus: vi.fn(),
    accessRequested: false,
    oauthError: null,
    clearOauthError: vi.fn(),
    pendingLink: null,
    mfaRequired: false,
    mfaResolver: null,
    clearMfaChallenge: vi.fn(),
    customMfaRequired: false,
    customMfaStatus: null,
    clearCustomMfaChallenge: vi.fn(),
    completeCustomMfaChallenge: vi.fn(),
  };
  return {
    AuthProvider: ({ children }: { children: React.ReactNode }) => children,
    useAuth: () => value,
  };
});

// --- Firebase I/O -----------------------------------------------------------
// Only the network edge. Reads answer from the fixtures below (one transaction,
// every other collection empty, single docs from docFixtures above, the rest
// missing); writes resolve.

vi.mock("firebase/firestore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("firebase/firestore")>();

  // Server-confirmed, not from cache: some hooks wait for that before acting.
  const metadata = { fromCache: false, hasPendingWrites: false, isEqual: () => true };
  const querySnapshot = (docs: ReturnType<typeof docSnapshot>[]) => ({
    docs,
    empty: docs.length === 0,
    size: docs.length,
    metadata,
    forEach: (fn: (d: unknown) => void) => docs.forEach(fn),
    docChanges: () => [],
  });
  const docSnapshot = (id: string, data: Record<string, unknown> | undefined) => ({
    id,
    ref: null,
    metadata,
    exists: () => data !== undefined,
    data: () => data,
    get: (field: string) => data?.[field],
  });

  // Collection path of every ref/query the app builds, so a read can be
  // answered per collection. `query()` returns a fresh object, hence the
  // hand-off from its base.
  const pathOf = new WeakMap<object, string>();
  const collection = ((...args: Parameters<typeof actual.collection>) => {
    const ref = actual.collection(...args);
    pathOf.set(ref, ref.path);
    return ref;
  }) as typeof actual.collection;
  const query = ((base: object, ...constraints: never[]) => {
    const q = (actual.query as (...a: unknown[]) => object)(base, ...constraints);
    const path = pathOf.get(base);
    if (path) pathOf.set(q, path);
    return q;
  }) as unknown as typeof actual.query;

  const now = actual.Timestamp.fromDate(new Date("2026-09-01T10:00:00Z"));
  // One transaction is enough: the toolbar's counter, and the documentation
  // ring's <Tooltip> inside it (#365), only render when there is at least one.
  const fixtures: Record<string, ReturnType<typeof docSnapshot>[]> = {
    transactions: [
      docSnapshot("smoke-tx-1", {
        userId: "smoke-user",
        sourceId: "smoke-source",
        date: now,
        amount: -1299,
        currency: "EUR",
        _original: { date: "01.09.2026", amount: "-12,99", rawRow: {} },
        name: "Smoke Test GmbH",
        description: null,
        partner: "Smoke Test GmbH",
        reference: null,
        partnerIban: null,
        dedupeHash: "smoke-tx-1",
        fileIds: [],
        isComplete: false,
        importJobId: null,
        createdAt: now,
        updatedAt: now,
      }),
    ],
  };
  const read = (ref: unknown) => {
    if (ref instanceof actual.DocumentReference) return docSnapshot(ref.id, docFixtures[ref.path]);
    const path = pathOf.get(ref as object) ?? "";
    return querySnapshot(fixtures[path.split("/").pop() ?? ""] ?? []);
  };

  return {
    ...actual,
    collection,
    query,
    onSnapshot: (ref: unknown, ...rest: unknown[]) => {
      const next = rest.find((a) => typeof a === "function") as ((s: unknown) => void) | undefined;
      const observer = rest.find((a) => typeof a === "object" && a !== null && "next" in (a as object)) as
        | { next?: (s: unknown) => void }
        | undefined;
      queueMicrotask(() => (next ?? observer?.next)?.(read(ref)));
      return () => {};
    },
    getDocs: async (ref: unknown) => read(ref),
    getDocsFromServer: async (ref: unknown) => read(ref),
    getDocsFromCache: async (ref: unknown) => read(ref),
    getDoc: async (ref: unknown) => read(ref),
    getDocFromServer: async (ref: unknown) => read(ref),
    getCountFromServer: async () => ({ data: () => ({ count: 0 }) }),
    getAggregateFromServer: async () => ({ data: () => ({}) }),
    addDoc: async () => ({ id: "smoke-doc" }),
    setDoc: async () => {},
    updateDoc: async () => {},
    deleteDoc: async () => {},
    runTransaction: async () => undefined,
    writeBatch: () => ({ set() {}, update() {}, delete() {}, commit: async () => {} }),
  };
});

vi.mock("firebase/functions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("firebase/functions")>();
  return { ...actual, httpsCallable: () => async () => ({ data: {} }) };
});

// --- Pages and the provider tree -------------------------------------------

import { ThemeProvider } from "@/components/theme/theme-provider";
import { NextIntlClientProvider } from "next-intl";
import messages from "@/messages/de.json";
import DashboardLayout from "@/app/(dashboard)/layout";
import DashboardTemplate from "@/app/(dashboard)/template";
import TransactionsPage from "@/app/(dashboard)/transactions/page";
import FilesPage from "@/app/(dashboard)/files/page";
import PartnersPage from "@/app/(dashboard)/partners/page";
import SourcesPage from "@/app/(dashboard)/sources/page";

async function renderDashboardPage(pathname: string, Page: React.ComponentType) {
  nav.pathname = pathname;
  // Render errors surface through React's error path; turn any of them into a
  // test failure instead of a console line.
  const errors: unknown[] = [];
  const onError = (e: ErrorEvent) => errors.push(e.error ?? e.message);
  window.addEventListener("error", onError);
  try {
    await act(async () => {
      render(
        <ThemeProvider>
          <NextIntlClientProvider locale="de" messages={messages} timeZone="Europe/Vienna">
            <DashboardLayout>
              <DashboardTemplate>
                <Page />
              </DashboardTemplate>
            </DashboardLayout>
          </NextIntlClientProvider>
        </ThemeProvider>
      );
    });
    // Let the empty snapshots land and the effects they trigger re-render.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  } finally {
    window.removeEventListener("error", onError);
  }
  expect(errors).toEqual([]);
  // The layout's header rendered, so the whole provider tree mounted rather
  // than ProtectedRoute's loading screen.
  expect(screen.getAllByText("FiBuKI").length).toBeGreaterThan(0);
}

describe("dashboard pages render inside the real dashboard layout", () => {
  beforeEach(() => {
    window.localStorage.clear();
    for (const path of Object.keys(docFixtures)) delete docFixtures[path];
    docFixtures["subscriptions/smoke-user"] = SMART_SUBSCRIPTION;
  });

  it("Transactions (table + toolbar)", async () => {
    await renderDashboardPage("/transactions", TransactionsPage);
    // The real toolbar and table, not the Suspense skeleton: the counter (and
    // the documentation ring's <Tooltip> beside it) only exists once the
    // fixture row arrived, and the column headers are the table's.
    expect(screen.getByText(/-12,99/)).toBeTruthy();
    expect(screen.getByText("Description")).toBeTruthy();
  });

  it("Transactions on the free plan (no subscription doc)", async () => {
    // The layout's plan-filtered nav and the billing banner take their free
    // branch here; every other case renders them on Smart.
    delete docFixtures["subscriptions/smoke-user"];
    await renderDashboardPage("/transactions", TransactionsPage);
    expect(screen.getByText(/-12,99/)).toBeTruthy();
    // The free path really ran: the nav dropped the Smart-only pages.
    expect(document.querySelector('a[href="/transactions"]')).not.toBeNull();
    expect(document.querySelector('a[href="/files"]')).toBeNull();
    expect(document.querySelector('a[href="/partners"]')).toBeNull();
  });

  it("Files", async () => {
    await renderDashboardPage("/files", FilesPage);
    // The page body, not the guard's null or the Suspense skeleton.
    expect(screen.getByText("No files uploaded")).toBeTruthy();
  });

  it("Partners", async () => {
    await renderDashboardPage("/partners", PartnersPage);
    expect(screen.getByText("No partners yet")).toBeTruthy();
  });

  it("Sources", async () => {
    await renderDashboardPage("/sources", SourcesPage);
    expect(screen.getByText("No bank accounts yet")).toBeTruthy();
  });
});
