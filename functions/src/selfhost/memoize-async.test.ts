/**
 * Unit coverage for the async memoizer behind the shared-singleton call
 * sites (auth-shim.ts `selfhostAuth`, migrate-import.ts `selfhostAuth`).
 *
 * The behavior that matters — and the deferred-LOW regression this pins — is
 * that a transient factory REJECTION is not cached: the singleton must be
 * able to recover on a later call instead of failing for the process's life.
 */

import { describe, it, expect, vi } from "vitest";
import { memoizeAsync } from "./memoize-async";

describe("memoizeAsync", () => {
  it("caches a fulfilled result — the factory runs once across many calls", async () => {
    const factory = vi.fn(async () => ({ id: 1 }));
    const get = memoizeAsync(factory);

    const [a, b, c] = await Promise.all([get(), get(), get()]);
    const d = await get();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(d).toBe(a); // same cached instance
  });

  it("does NOT cache a rejection — a transient boot failure recovers on retry", async () => {
    let attempt = 0;
    const factory = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("transient boot failure");
      return { booted: attempt };
    });
    const get = memoizeAsync(factory);

    // First call fails (database briefly unreachable).
    await expect(get()).rejects.toThrow("transient boot failure");
    // The plain `??=` idiom would replay this same rejection forever; the
    // memoizer must instead re-invoke the factory and recover.
    await expect(get()).resolves.toEqual({ booted: 2 });
    // And the recovered value is now cached — no third invocation.
    await expect(get()).resolves.toEqual({ booted: 2 });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("concurrent callers during an in-flight attempt share one invocation", async () => {
    let resolve!: (v: string) => void;
    const factory = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    );
    const get = memoizeAsync(factory);

    const p1 = get();
    const p2 = get();
    expect(factory).toHaveBeenCalledTimes(1);
    resolve("ready");
    expect(await p1).toBe("ready");
    expect(await p2).toBe("ready");
  });

  it("both concurrent callers of a failing attempt reject, then the slot is free", async () => {
    let attempt = 0;
    const factory = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
      return "ok";
    });
    const get = memoizeAsync(factory);

    const p1 = get();
    const p2 = get();
    await expect(p1).rejects.toThrow("boom");
    await expect(p2).rejects.toThrow("boom");
    expect(factory).toHaveBeenCalledTimes(1); // shared the one in-flight attempt
    await expect(get()).resolves.toBe("ok"); // slot freed -> retry succeeds
  });
});
