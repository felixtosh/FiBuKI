/**
 * #649: one detail-panel layout owns the resizable right-hand panel of the list
 * pages. These tests pin its interface: a stored width is restored, a drag is
 * clamped to the page's limits, and the release writes the width to the page's
 * own storage key.
 */

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DetailPanelLayout } from "@/components/ui/detail-panel-layout";

const KEY = "testDetailPanelWidth";
const LIMITS = { storageKey: KEY, defaultWidth: 480, minWidth: 280, maxWidth: 700 };

async function renderLayout(open = true) {
  const view = render(
    <DetailPanelLayout {...LIMITS} open={open} panel={open ? <p>detail</p> : null}>
      <p>list</p>
    </DetailPanelLayout>
  );
  const main = () => view.container.querySelector<HTMLElement>("[data-slot='detail-panel-main']")!;
  const panel = () => view.container.querySelector<HTMLElement>("[data-slot='detail-panel']");
  const handle = () => view.getByRole("separator");
  // The stored width is restored in a microtask after mount.
  await act(async () => {});
  return { ...view, main, panel, handle };
}

function drag(handle: HTMLElement, fromX: number, toX: number, release = true) {
  fireEvent.mouseDown(handle, { clientX: fromX });
  fireEvent.mouseMove(document, { clientX: toX });
  if (release) fireEvent.mouseUp(document);
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("DetailPanelLayout", () => {
  it("opens at the default width with nothing stored", async () => {
    const { main, panel } = await renderLayout();
    expect(panel()!.style.width).toBe("480px");
    expect(main().style.marginRight).toBe("480px");
  });

  it("restores a stored width inside the limits", async () => {
    localStorage.setItem(KEY, "550");
    const { main, panel } = await renderLayout();
    expect(panel()!.style.width).toBe("550px");
    expect(main().style.marginRight).toBe("550px");
  });

  it("opens at a stored width on its first render, not a tick later", () => {
    // The pages mount the layout only after their data loads, often with the
    // panel already open (?id= in the URL). A width restored after the first
    // paint shows the default first and slides the list's margin across.
    localStorage.setItem(KEY, "550");
    const view = render(
      <DetailPanelLayout {...LIMITS} open panel={<p>detail</p>}>
        <p>list</p>
      </DetailPanelLayout>
    );
    const panel = view.container.querySelector<HTMLElement>("[data-slot='detail-panel']")!;
    const main = view.container.querySelector<HTMLElement>("[data-slot='detail-panel-main']")!;
    expect(panel.style.width).toBe("550px");
    expect(main.style.marginRight).toBe("550px");
  });

  it("ignores a stored width that is not a number", async () => {
    localStorage.setItem(KEY, "wide");
    const { panel } = await renderLayout();
    expect(panel()!.style.width).toBe("480px");
  });

  it("ignores a stored width outside the limits", async () => {
    localStorage.setItem(KEY, "950");
    const { panel } = await renderLayout();
    expect(panel()!.style.width).toBe("480px");
  });

  it("gives the list no margin and renders no panel while closed", async () => {
    const { main, panel } = await renderLayout(false);
    expect(main().style.marginRight).toBe("0px");
    expect(panel()).toBeNull();
  });

  it("widens the panel when dragged left, writing the DOM before the release", async () => {
    const { main, panel, handle } = await renderLayout();
    drag(handle(), 1000, 900, false);
    expect(panel()!.style.width).toBe("580px");
    // The list's margin follows on release, not on every mouse move.
    expect(main().style.marginRight).toBe("480px");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("clamps a drag to the maximum", async () => {
    const { panel, handle } = await renderLayout();
    drag(handle(), 1000, 0, false);
    expect(panel()!.style.width).toBe("700px");
  });

  it("clamps a drag to the minimum", async () => {
    const { panel, handle } = await renderLayout();
    drag(handle(), 1000, 2000, false);
    expect(panel()!.style.width).toBe("280px");
  });

  it("commits and persists the clamped width to the given key on release", async () => {
    const { main, panel, handle } = await renderLayout();
    drag(handle(), 1000, 0);
    expect(localStorage.getItem(KEY)).toBe("700");
    expect(panel()!.style.width).toBe("700px");
    expect(main().style.marginRight).toBe("700px");
  });

  it("keeps a restored width when released without moving", async () => {
    localStorage.setItem(KEY, "600");
    const { panel, handle } = await renderLayout();
    fireEvent.mouseDown(handle(), { clientX: 1000 });
    fireEvent.mouseUp(document);
    expect(panel()!.style.width).toBe("600px");
    expect(localStorage.getItem(KEY)).toBe("600");
  });

  it("stops listening when unmounted mid-drag", async () => {
    const { handle, unmount } = await renderLayout();
    drag(handle(), 1000, 900, false);
    unmount();
    fireEvent.mouseUp(document);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("stops following the mouse after the release", async () => {
    const { panel, handle } = await renderLayout();
    drag(handle(), 1000, 900);
    fireEvent.mouseMove(document, { clientX: 500 });
    expect(panel()!.style.width).toBe("580px");
  });

  it("draws the handle as a visible bar at rest, on every page", async () => {
    const { handle } = await renderLayout();
    expect(handle().className.split(/\s+/)).toContain("bg-border");
    expect(handle().className).toContain("hover:bg-primary/20");
  });
});
