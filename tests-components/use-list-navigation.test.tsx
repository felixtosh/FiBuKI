/**
 * #649: one list-navigation hook for Files and Transactions. These tests pin
 * its interface: neighbours follow the display order, the ends report no
 * neighbour, the arrow keys step the panel and are ignored while typing, and
 * the advance after a disposition goes to the row that was next before the
 * write.
 */

import { act, fireEvent, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useListNavigation } from "@/hooks/use-list-navigation";

// Display order differs from id order on purpose: the hook must not sort.
const ORDER = ["c", "a", "b"];

function setup(
  currentId: string | null,
  extra: { panelOpen?: boolean; connectOverlayOpen?: boolean; orderedIds?: string[] } = {}
) {
  const onNavigate = vi.fn();
  const view = renderHook(
    (props: { currentId: string | null; orderedIds: string[] }) =>
      useListNavigation({
        orderedIds: props.orderedIds,
        currentId: props.currentId,
        onNavigate,
        panelOpen: extra.panelOpen ?? true,
        connectOverlayOpen: extra.connectOverlayOpen ?? false,
      }),
    { initialProps: { currentId, orderedIds: extra.orderedIds ?? ORDER } }
  );
  return { ...view, onNavigate };
}

describe("useListNavigation: neighbours", () => {
  it("follows the display order", () => {
    const { result, onNavigate } = setup("a");
    expect(result.current.hasPrevious).toBe(true);
    expect(result.current.hasNext).toBe(true);
    act(() => result.current.goNext());
    expect(onNavigate).toHaveBeenLastCalledWith("b");
    act(() => result.current.goPrevious());
    expect(onNavigate).toHaveBeenLastCalledWith("c");
  });

  it("reports no previous on the first row and does not navigate", () => {
    const { result, onNavigate } = setup("c");
    expect(result.current.hasPrevious).toBe(false);
    act(() => result.current.goPrevious());
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("reports no next on the last row and does not wrap", () => {
    const { result, onNavigate } = setup("b");
    expect(result.current.hasNext).toBe(false);
    act(() => result.current.goNext());
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("reports no neighbour when the current row is not in the order", () => {
    const { result } = setup("zz");
    expect(result.current.hasPrevious).toBe(false);
    expect(result.current.hasNext).toBe(false);
  });

  it("follows a new order when the table re-sorts", () => {
    const { result, rerender, onNavigate } = setup("a");
    rerender({ currentId: "a", orderedIds: ["a", "b", "c"] });
    expect(result.current.hasPrevious).toBe(false);
    act(() => result.current.goNext());
    expect(onNavigate).toHaveBeenLastCalledWith("b");
  });
});

describe("useListNavigation: arrow keys", () => {
  it("steps with left and right", () => {
    const { onNavigate } = setup("a");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onNavigate).toHaveBeenLastCalledWith("b");
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(onNavigate).toHaveBeenLastCalledWith("c");
  });

  it("ignores the keys while typing", () => {
    const { onNavigate } = setup("a");
    const input = document.createElement("input");
    document.body.appendChild(input);
    try {
      fireEvent.keyDown(input, { key: "ArrowRight" });
      expect(onNavigate).not.toHaveBeenCalled();
    } finally {
      input.remove();
    }
  });

  it("ignores modified arrows", () => {
    const { onNavigate } = setup("a");
    fireEvent.keyDown(window, { key: "ArrowRight", metaKey: true });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("ignores the keys while a dialog is open", () => {
    const { onNavigate } = setup("a");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    try {
      fireEvent.keyDown(window, { key: "ArrowRight" });
      expect(onNavigate).not.toHaveBeenCalled();
    } finally {
      dialog.remove();
    }
  });

  it("listens only while the panel is open", () => {
    const { onNavigate } = setup("a", { panelOpen: false });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("is switched off while a connect overlay covers the list", () => {
    const { onNavigate } = setup("a", { connectOverlayOpen: true });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("stops listening on unmount", () => {
    const { onNavigate, unmount } = setup("a");
    unmount();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe("useListNavigation: advance after a disposition", () => {
  it("opens the row that was next before the write", async () => {
    const { result, onNavigate } = setup("a");
    const mutate = vi.fn().mockResolvedValue(undefined);
    let advancedTo: string | null = null;
    await act(async () => {
      advancedTo = await result.current.advanceAfter(mutate);
    });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith("b");
    expect(advancedTo).toBe("b");
  });

  it("stays on the last row", async () => {
    const { result, onNavigate } = setup("b");
    await act(async () => {
      await result.current.advanceAfter(() => Promise.resolve());
    });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("does not navigate when the write fails", async () => {
    const { result, onNavigate } = setup("a");
    await act(async () => {
      await expect(
        result.current.advanceAfter(() => Promise.reject(new Error("nope")))
      ).rejects.toThrow("nope");
    });
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
