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
 * What is deliberately NOT here
 * -----------------------------
 * No ResizeObserver / IntersectionObserver / matchMedia / scrollTo stubs, and
 * no getBoundingClientRect override. jsdom implements none of the first four
 * and returns all-zero rects from the last one, so a component that measures
 * itself — anything reaching @tanstack/react-virtual, or a Radix primitive that
 * positions a floating layer — WILL need stubs. They are not here because the
 * only component tested so far needs none of them: VirtualRow takes its
 * geometry (virtualStart, virtualSize, columnSizes) as plain props, which is
 * exactly what makes it testable in isolation.
 *
 * If you add such a stub, put it here, and be honest in the test about what the
 * stub means: a hand-fed getBoundingClientRect makes a virtualizer render, but
 * the test then asserts against numbers you supplied rather than real layout.
 * Prefer components that accept their geometry as props.
 *
 * Likewise unmocked: next/navigation, next/image, next-intl and next-themes.
 * Keep a component test's import graph small enough not to reach them; mock
 * per-test-file (vi.mock) rather than globally if you must, so the blast radius
 * of the mock is visible in the file that needs it.
 */

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
