/**
 * Files page: ticking checkboxes accumulates a selection (#232, harness #295).
 *
 * The bug this guards
 * -------------------
 * Ticking a second File's checkbox cleared the first: a radio group, not a
 * multi-select. The toggle helper (toggleFileCheckbox) was correct the whole
 * time. The cause was React: the table's rows are memoised (VirtualRow), and
 * the comparator only lets a row re-render when that row's own selection flags
 * move. A row that skipped a render kept the checkbox handler from its last
 * paint, and with it that render's copy of the page's additionalSelectedIds.
 * Ticking row B after row A therefore toggled against the empty set B last
 * saw, and {B} replaced {A}. Scrolling healed it, because scrolling remounts
 * rows.
 *
 * So the test has to sit where the bug lives: the real Files page, the real
 * table with its real memoised rows, and real clicks on the real checkboxes.
 * A test against the pure helper passes with the bug fully present. The fix is
 * the page's checkbox handler going through useLatestCallback; replace that
 * with a plain closure (or a useCallback over additionalSelectedIds) and both
 * tests below go red.
 *
 * What is mocked
 * --------------
 * The same edges as dashboard-render-smoke.test.tsx, for the same reasons:
 * auth, the Firebase network calls (the files collection answers with three
 * Files), the Next runtime, and react-pdf. Nothing in app/ or components/ is
 * mocked.
 *
 * Plus one geometry stub, scoped to this file: jsdom has no layout, so every
 * element's offsetWidth/offsetHeight is 0 and the virtualizer renders no body
 * rows at all. For the duration of these tests every element reports 1000 x
 * 1000. That is a number we supply, not real layout, and nothing here asserts
 * against it: it only makes the scroll container big enough for all three rows
 * to mount. Which rows are on screen is not what this test is about.
 */

import * as React from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

// --- Next runtime -----------------------------------------------------------

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
    usePathname: () => "/files",
    // No ?id=: no File is being browsed, so no detail panel. Every selection in
    // these tests is a bulk selection, made only through the checkboxes.
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

vi.mock("react-pdf", () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));

// --- Auth -------------------------------------------------------------------

vi.mock("@/components/auth/auth-provider", () => {
  const user = { uid: "test-user", email: "test@example.com", displayName: "Test User" };
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
// Only the network edge, as in the smoke test. The files collection answers
// with three Files and the user's subscription doc exists; every other
// collection is empty, every other single doc missing.

vi.mock("firebase/firestore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("firebase/firestore")>();

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
  const file = (id: string, fileName: string) =>
    docSnapshot(id, {
      userId: "test-user",
      fileName,
      fileType: "application/pdf",
      fileSize: 1024,
      storagePath: `files/test-user/${id}.pdf`,
      downloadUrl: `https://example.invalid/${id}.pdf`,
      extractionComplete: true,
      transactionIds: [],
      uploadedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  const fixtures: Record<string, ReturnType<typeof docSnapshot>[]> = {
    files: [file("file-a", "alpha.pdf"), file("file-b", "bravo.pdf"), file("file-c", "charlie.pdf")],
  };
  // The Files page sits behind SmartFeatureGuard("fileUpload"). With no
  // subscription doc the user is on the free plan and the page renders nothing
  // at all, so the user needs a plan that includes File upload.
  const docFixtures: Record<string, Record<string, unknown>> = {
    "subscriptions/test-user": { plan: "smart", status: "active" },
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
    addDoc: async () => ({ id: "test-doc" }),
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

// --- The page ----------------------------------------------------------------

import { ThemeProvider } from "@/components/theme/theme-provider";
import { NextIntlClientProvider } from "next-intl";
import messages from "@/messages/en.json";
import DashboardLayout from "@/app/(dashboard)/layout";
import DashboardTemplate from "@/app/(dashboard)/template";
import FilesPage from "@/app/(dashboard)/files/page";

// --- Geometry stub (see the header) -----------------------------------------

const STUBBED = ["offsetWidth", "offsetHeight"] as const;
const originals = new Map<string, PropertyDescriptor | undefined>();

beforeAll(() => {
  for (const prop of STUBBED) {
    originals.set(prop, Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop));
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => 1000 });
  }
});

afterAll(() => {
  for (const prop of STUBBED) {
    const original = originals.get(prop);
    if (original) Object.defineProperty(HTMLElement.prototype, prop, original);
  }
});

// --- Helpers -----------------------------------------------------------------

async function renderFilesPage() {
  await act(async () => {
    render(
      <ThemeProvider>
        <NextIntlClientProvider locale="en" messages={messages} timeZone="Europe/Vienna">
          <DashboardLayout>
            <DashboardTemplate>
              <FilesPage />
            </DashboardTemplate>
          </DashboardLayout>
        </NextIntlClientProvider>
      </ThemeProvider>
    );
  });
  // Let the files snapshot land and the effects it triggers re-render.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** A File row's checkbox, found the way a user finds it: by its label. */
const checkbox = (fileName: string) => screen.getByRole("checkbox", { name: `Select ${fileName}` });

const isTicked = (fileName: string) => checkbox(fileName).getAttribute("aria-checked") === "true";

async function click(fileName: string) {
  await act(async () => {
    fireEvent.click(checkbox(fileName));
  });
}

// --- Tests -------------------------------------------------------------------

describe("Files page checkboxes accumulate a selection (#232)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("ticking three checkboxes leaves all three ticked, and the bulk panel counts three", async () => {
    await renderFilesPage();
    // All three rows mounted, none ticked. Without this a missing row would
    // fail later for the wrong reason.
    expect(["alpha.pdf", "bravo.pdf", "charlie.pdf"].map(isTicked)).toEqual([false, false, false]);

    await click("alpha.pdf");
    // One ticked File still shows its own detail panel; the bulk panel takes
    // over from two.
    expect(["alpha.pdf", "bravo.pdf", "charlie.pdf"].map(isTicked)).toEqual([true, false, false]);

    // The second tick is where the radio group showed: bravo's row skipped
    // the render alpha's tick caused, so a stale handler sees an empty set.
    await click("bravo.pdf");
    expect(["alpha.pdf", "bravo.pdf", "charlie.pdf"].map(isTicked)).toEqual([true, true, false]);
    expect(screen.getByText("2 files selected")).toBeTruthy();

    await click("charlie.pdf");
    expect(["alpha.pdf", "bravo.pdf", "charlie.pdf"].map(isTicked)).toEqual([true, true, true]);
    expect(screen.getByText("3 files selected")).toBeTruthy();
  });

  it("unticking one of three ticked rows leaves the other two ticked", async () => {
    await renderFilesPage();

    await click("alpha.pdf");
    await click("bravo.pdf");
    await click("charlie.pdf");
    expect(screen.getByText("3 files selected")).toBeTruthy();

    // bravo's row last painted after its own tick, when the set was {a, b}.
    // A stale handler would untick it from that set and drop charlie as well.
    await click("bravo.pdf");
    expect(["alpha.pdf", "bravo.pdf", "charlie.pdf"].map(isTicked)).toEqual([true, false, true]);
    expect(screen.getByText("2 files selected")).toBeTruthy();
  });
});
