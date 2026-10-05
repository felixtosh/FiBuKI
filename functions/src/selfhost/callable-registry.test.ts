/**
 * The callable registry (#648) against the barrel the API host mounts.
 *
 * The host serves each callable at `POST /<exportName>`, and the app calls the
 * names in the registry. So the barrel's callables must be exactly the
 * registry's names, and each `createCallable` export must be named after its
 * `config.name` (which keys the usage log, so the export follows it, never the
 * other way round). Driven off the barrel, like the cross-user callable suite,
 * so a callable added tomorrow is checked tomorrow.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeAll } from "vitest";
import { CALLABLE_NAMES } from "../callableRegistry";
import { callableConfigName } from "../utils/createCallable";

const barrelPromise = import("../index");

let callables: Array<[string, unknown]> = [];

beforeAll(async () => {
  const barrel = (await barrelPromise) as Record<string, unknown>;
  callables = Object.entries(barrel).filter(
    ([, v]) => typeof v === "function" && "__selfhostCallable" in (v as object),
  );
}, 120_000);

describe("callable registry", () => {
  it("covers the whole barrel", () => {
    // A barrel that failed to load would make every case below vacuous.
    expect(callables.length).toBeGreaterThan(100);
  });

  it("lists each name once", () => {
    expect(new Set(CALLABLE_NAMES).size).toBe(CALLABLE_NAMES.length);
  });

  it("holds exactly the callables the barrel exports", () => {
    const exported = callables.map(([name]) => name).sort();
    expect(exported).toEqual([...CALLABLE_NAMES].sort());
  });

  it("serves each callable under its config.name", () => {
    const mismatched = callables
      .map(([name, fn]) => [name, callableConfigName(fn)] as const)
      .filter(([name, configName]) => configName !== undefined && configName !== name)
      .map(([name, configName]) => `${name} (config.name ${configName})`);
    expect(mismatched).toEqual([]);
  });

  it("reads config.name off every createCallable export", () => {
    // Guards the check above: if the side table broke, every callable would
    // read as "no config.name" and the mismatch check would pass vacuously.
    const named = callables.filter(([, fn]) => callableConfigName(fn) !== undefined);
    expect(named.length).toBeGreaterThan(100);
  });
});
