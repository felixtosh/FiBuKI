/**
 * Poke coalescing.
 *
 * A poke costs one request per live listener, and the realtime stream pokes on
 * every change frame, so an uncoalesced bus answers a burst of server-side writes
 * with (changes x listeners) requests. On the self-host deployment that was enough
 * to exhaust the host's rate limiter and fail every listener at once.
 *
 * The properties worth pinning: the FIRST poke is still immediate (a user's own
 * action must not wait on a timer), a burst costs one extra fan-out rather than
 * one per poke, and the LAST change in a burst is always refetched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  pokePollers,
  registerPoller,
  __pollerCount,
  __resetPokeWindow,
} from "../../../lib/selfhost/poll-bus";

describe("pokePollers coalescing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetPokeWindow();
  });

  afterEach(() => {
    __resetPokeWindow();
    vi.useRealTimers();
  });

  it("fans out immediately on the first poke", () => {
    let calls = 0;
    const off = registerPoller(() => calls++);

    pokePollers();
    expect(calls).toBe(1);

    off();
    expect(__pollerCount()).toBe(0);
  });

  it("collapses a burst into one trailing fan-out", () => {
    let calls = 0;
    const off = registerPoller(() => calls++);

    pokePollers(); // leading edge
    for (let i = 0; i < 50; i++) {
      vi.advanceTimersByTime(5);
      pokePollers();
    }
    expect(calls).toBe(1); // 51 pokes, still one fan-out

    vi.advanceTimersByTime(400);
    expect(calls).toBe(2); // ...plus exactly one trailing catch-up

    off();
  });

  it("refetches after the window even if the last change lands late in it", () => {
    const seen: number[] = [];
    const off = registerPoller(() => seen.push(Date.now()));

    pokePollers();
    vi.advanceTimersByTime(399);
    pokePollers(); // the change that must not be lost
    vi.advanceTimersByTime(400);

    expect(seen).toHaveLength(2);
    off();
  });

  it("is immediate again once the window has passed", () => {
    let calls = 0;
    const off = registerPoller(() => calls++);

    pokePollers();
    expect(calls).toBe(1);
    vi.advanceTimersByTime(401);
    pokePollers();
    expect(calls).toBe(2); // no trailing timer needed — a quiet bus stays responsive

    off();
  });

  it("scales with listeners, not with pokes", () => {
    let calls = 0;
    const offs = Array.from({ length: 30 }, () => registerPoller(() => calls++));

    pokePollers();
    for (let i = 0; i < 100; i++) pokePollers();
    vi.advanceTimersByTime(400);

    // 101 pokes x 30 listeners would be 3030 requests; two fan-outs is 60.
    expect(calls).toBe(60);
    offs.forEach((off) => off());
  });

  it("still fans out to the survivors when a subscriber throws", () => {
    let calls = 0;
    const offBad = registerPoller(() => {
      throw new Error("subscriber blew up");
    });
    const offGood = registerPoller(() => calls++);

    expect(() => pokePollers()).not.toThrow();
    expect(calls).toBe(1);

    offBad();
    offGood();
  });
});
