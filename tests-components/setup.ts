/**
 * Shared setup for the jsdom component suite (vitest.components.config.ts).
 *
 * Read this before writing a new component test — it says what the environment
 * does and does not give you.
 *
 * What is here
 * ------------
 * Only unmount-between-tests. @testing-library/react auto-registers its own
 * cleanup when the test framework exposes `afterEach` as a global; this suite
 * runs with `globals: false` (see the config for why), so auto-cleanup does not
 * fire and we register it by hand. Without it every render accumulates in the
 * same document and queries start matching the previous test's DOM.
 *
 * Browser-API stubs, and what is still deliberately NOT here
 * ----------------------------------------------------------
 * jsdom implements no ResizeObserver, IntersectionObserver, matchMedia or
 * scrollTo, and returns all-zero rects from getBoundingClientRect. The
 * dashboard render smoke tests (dashboard-render-smoke.test.tsx) mount the
 * whole layout, which reaches all of the first four, so they are stubbed at the
 * bottom of this file. Each is the inert minimum: matchMedia never matches, the
 * observers never fire, scrolling does nothing. None of them feeds geometry.
 *
 * There is still no getBoundingClientRect override, so a virtualizer
 * (@tanstack/react-virtual) renders no rows here. VirtualRow's tests do not
 * need one because VirtualRow takes its geometry (virtualStart, virtualSize,
 * columnSizes) as plain props, which is exactly what makes it testable in
 * isolation.
 *
 * If you add such a stub, put it here, and be honest in the test about what the
 * stub means: a hand-fed getBoundingClientRect makes a virtualizer render, but
 * the test then asserts against numbers you supplied rather than real layout.
 * Prefer components that accept their geometry as props.
 *
 * Not mocked here: next/navigation, next/image, next-intl and next-themes.
 * Keep a component test's import graph small enough not to reach them; mock
 * per-test-file (vi.mock) rather than globally if you must, so the blast radius
 * of the mock is visible in the file that needs it.
 */

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

// Inert browser-API stubs; see the header. Guarded so a future jsdom that
// implements one wins over the stub.
if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList;
  }
  class InertObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  if (!("ResizeObserver" in window)) {
    (window as unknown as Record<string, unknown>).ResizeObserver = InertObserver;
  }
  if (!("IntersectionObserver" in window)) {
    (window as unknown as Record<string, unknown>).IntersectionObserver = InertObserver;
  }
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.scrollTo ??= () => {};
}
