/**
 * Every example on /design-system mounts without throwing. The examples render
 * the real components, so a renamed prop or a changed data shape that breaks
 * one fails here instead of leaving a broken page behind.
 * scripts/check-design-system.mjs makes sure every component has examples;
 * this makes sure they still work.
 */

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { componentDocs } from "@/app/(dashboard)/design-system/registry";

// FibukiMascot draws an image; next/image needs Next's runtime config.
vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: (props: Record<string, unknown>) => <img alt="" src={String(props.src)} />,
}));

describe("design-system examples", () => {
  it("covers some components", () => {
    expect(componentDocs.length).toBeGreaterThan(0);
  });

  for (const doc of componentDocs) {
    for (const { name, Example } of doc.examples) {
      it(`${doc.title}: ${name}`, () => {
        const errors: unknown[] = [];
        const spy = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
        // Wrapped like the page wraps them (and the app layout wraps every page).
        const { container } = render(
          <TooltipProvider>
            <Example />
          </TooltipProvider>
        );
        spy.mockRestore();
        expect(container.childNodes.length).toBeGreaterThan(0);
        expect(errors).toEqual([]);
      });
    }
  }
});
