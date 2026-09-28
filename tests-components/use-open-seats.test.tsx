/**
 * #415: the register page's open-seats banner reads the public getOpenSeats
 * callable once on mount, instead of an onSnapshot listener that polled the
 * authenticated-only self-host data plane (a 401 every poll for a signed-out
 * tab).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const callFunction = vi.fn();
vi.mock("@/lib/firebase/callable", () => ({
  callFunction: (...args: unknown[]) => callFunction(...args),
}));

import { useOpenSeats } from "@/hooks/use-open-seats";

beforeEach(() => {
  callFunction.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useOpenSeats", () => {
  it("shows the counts when seats remain", async () => {
    callFunction.mockResolvedValue({ totalSeats: 10, remainingSeats: 3, claimedSeats: 7 });
    const { result } = renderHook(() => useOpenSeats());
    await waitFor(() => expect(result.current).toEqual({ total: 10, remaining: 3, claimed: 7 }));
    expect(callFunction).toHaveBeenCalledWith("getOpenSeats", null);
  });

  it("is null when no seats are configured, none remain, or the call fails", async () => {
    for (const make of [
      () => Promise.resolve(null),
      () => Promise.resolve({ totalSeats: 5, remainingSeats: 0, claimedSeats: 5 }),
      () => Promise.reject(new Error("unavailable")),
    ]) {
      const outcome = make();
      callFunction.mockReturnValueOnce(outcome);
      const { result, unmount } = renderHook(() => useOpenSeats());
      await act(async () => {
        await outcome.catch(() => undefined);
      });
      expect(result.current).toBeNull();
      unmount();
    }
  });

  it("fetches exactly once and does not poll, even after the old poll interval", async () => {
    vi.useFakeTimers();
    callFunction.mockRejectedValue(Object.assign(new Error("denied"), { code: "unauthenticated" }));
    renderHook(() => useOpenSeats());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(callFunction).toHaveBeenCalledTimes(1);
  });
});
