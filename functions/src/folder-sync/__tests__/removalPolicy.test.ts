import { describe, expect, it } from "vitest";
import {
  breakerTripped,
  decideGoneFile,
  removalLimit,
  type GoneFileState,
} from "../removalPolicy";

const file = (o: Partial<GoneFileState> = {}): GoneFileState => ({
  connected: false,
  deleted: false,
  alreadyMarkedGone: false,
  ...o,
});
const off = { removeConnectedFiles: false };
const on = { removeConnectedFiles: true };

describe("decideGoneFile (ADR-0009)", () => {
  it("deletes an unconnected File, whatever the toggle says", () => {
    expect(decideGoneFile(file(), off)).toBe("delete");
    expect(decideGoneFile(file(), on)).toBe("delete");
  });

  it("keeps a connected File and marks it by default", () => {
    expect(decideGoneFile(file({ connected: true }), off)).toBe("mark");
  });

  it("does not mark a connected File twice", () => {
    expect(decideGoneFile(file({ connected: true, alreadyMarkedGone: true }), off)).toBe("none");
  });

  it("deletes a connected File only when the toggle is on", () => {
    expect(decideGoneFile(file({ connected: true }), on)).toBe("delete");
  });

  it("leaves an already deleted File alone", () => {
    expect(decideGoneFile(file({ deleted: true }), on)).toBe("none");
    expect(decideGoneFile(file({ deleted: true, connected: true }), off)).toBe("none");
  });
});

describe("circuit breaker", () => {
  it("allows 25 % of the imported Files, between 3 and 10", () => {
    expect(removalLimit(4)).toBe(3);
    expect(removalLimit(20)).toBe(5);
    expect(removalLimit(40)).toBe(10);
    expect(removalLimit(1000)).toBe(10);
  });

  it("trips only above the limit", () => {
    expect(breakerTripped(5, 20)).toBe(false);
    expect(breakerTripped(6, 20)).toBe(true);
  });

  it("trips when a small folder loses everything", () => {
    expect(breakerTripped(4, 4)).toBe(true);
    expect(breakerTripped(3, 4)).toBe(false);
  });

  it("never trips on zero removals", () => {
    expect(breakerTripped(0, 0)).toBe(false);
  });
});
