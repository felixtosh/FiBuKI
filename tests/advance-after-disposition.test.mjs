import test from "node:test";
import assert from "node:assert/strict";
import { advanceAfterDisposition } from "../lib/navigation/advance-after-disposition.js";

/**
 * A stand-in for the Files page: `order` is the displayed order, which a
 * mutation may rewrite (the row leaves the list when a filter excludes it).
 */
function makePage(ids) {
  const page = {
    order: [...ids],
    navigatedTo: [],
    getOrder: () => page.order,
    navigateTo: (id) => page.navigatedTo.push(id),
  };
  return page;
}

test("advances to the next row when the marked row stays in the list", async () => {
  const page = makePage(["a", "b", "c"]);
  const result = await advanceAfterDisposition({
    orderedIds: page.getOrder(),
    currentId: "a",
    mutate: async () => {},
    navigateTo: page.navigateTo,
  });
  assert.equal(result, "b");
  assert.deepEqual(page.navigatedTo, ["b"]);
});

test("advances to the next row when the marked row is filtered out by the write", async () => {
  const page = makePage(["a", "b", "c"]);
  const result = await advanceAfterDisposition({
    orderedIds: page.getOrder(),
    currentId: "b",
    // The write lands and the Document chip excludes Other: "b" leaves the
    // list, so looking up "the row after b" now would find nothing.
    mutate: async () => {
      page.order = page.order.filter((id) => id !== "b");
    },
    navigateTo: page.navigateTo,
  });
  assert.equal(result, "c");
  assert.deepEqual(page.navigatedTo, ["c"]);
});

test("the next row is resolved before the write, not after it", async () => {
  const seen = [];
  await advanceAfterDisposition({
    orderedIds: ["a", "b", "c"],
    currentId: "a",
    mutate: async () => {
      seen.push("mutate");
    },
    navigateTo: (id) => seen.push(`navigate:${id}`),
  });
  assert.deepEqual(seen, ["mutate", "navigate:b"]);
});

test("the last row stays put: no wrap, no close", async () => {
  const page = makePage(["a", "b", "c"]);
  const result = await advanceAfterDisposition({
    orderedIds: page.getOrder(),
    currentId: "c",
    mutate: async () => {},
    navigateTo: page.navigateTo,
  });
  assert.equal(result, null);
  assert.deepEqual(page.navigatedTo, []);
});

test("a failed write does not navigate", async () => {
  const page = makePage(["a", "b"]);
  await assert.rejects(
    advanceAfterDisposition({
      orderedIds: page.getOrder(),
      currentId: "a",
      mutate: async () => {
        throw new Error("boom");
      },
      navigateTo: page.navigateTo,
    }),
    /boom/,
  );
  assert.deepEqual(page.navigatedTo, []);
});

test("a current row missing from the order still runs the write and does not navigate", async () => {
  let mutated = false;
  const navigatedTo = [];
  const result = await advanceAfterDisposition({
    orderedIds: ["a", "b"],
    currentId: "zz",
    mutate: async () => {
      mutated = true;
    },
    navigateTo: (id) => navigatedTo.push(id),
  });
  assert.equal(mutated, true);
  assert.equal(result, null);
  assert.deepEqual(navigatedTo, []);
});
