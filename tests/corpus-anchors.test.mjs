import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { FORBIDDEN } = require("../scripts/check-corpus-anchors.js");

/**
 * The guard refuses anchors that name one operator's private documents.
 *
 * Every example below is ASSEMBLED at runtime rather than written as a literal,
 * for the same reason the guard builds its own patterns that way: a test full
 * of real-looking ids would trip the very check it is testing, and the fastest
 * way to get a guard deleted is to make it fail on its own test suite.
 */
const id = (...parts) => parts.join("-");

function ruleNamed(name) {
  const rule = FORBIDDEN.find((r) => r.name === name);
  assert.ok(rule, `no rule named ${name}`);
  return rule;
}

test("a leading zero is what marks a number as invented", () => {
  const paperless = ruleNamed("Paperless document id");

  // Caught: these look like ids from a real instance, whatever their range.
  for (const n of ["1004", "2003", "42", "98765"]) {
    assert.equal(
      paperless.pattern.test(id("paperless", "ap", n)),
      true,
      `${n} should be caught`,
    );
  }

  // Passes: the convention both `fix` lines tell people to use.
  assert.equal(paperless.pattern.test(id("paperless", "ap", "0042")), false);
});

test("the invoice rule follows the same convention", () => {
  const invoice = ruleNamed("outgoing invoice number");

  for (const n of ["1004", "2001", "42"]) {
    assert.equal(invoice.pattern.test(id("IV", "26", n)), true, `${n} should be caught`);
  }
  assert.equal(invoice.pattern.test(id("IV", "25", "0042")), false);
});

test("the range regression is pinned: 1NNN is not the whole of what is real", () => {
  // The rules once read `1\d{3}`, which covers 1000-1999 and nothing else, so
  // an id one range over passed clean. This is the case that regression missed.
  const paperless = ruleNamed("Paperless document id");
  assert.equal(paperless.pattern.test(id("paperless", "ap", "2003")), true);
});

test("the FiBu rule accepts every separator the reference is written with", () => {
  const fibu = ruleNamed("FiBu document reference");
  const date = "20260109";
  for (const sep of [" ", "_", "-"]) {
    assert.equal(
      fibu.pattern.test(["FIBU", date].join(sep)),
      true,
      `separator ${JSON.stringify(sep)} should be caught`,
    );
  }
});

test("every rule carries a fix that names what to do instead", () => {
  for (const rule of FORBIDDEN) {
    assert.ok(rule.name && rule.name.length > 0);
    assert.ok(rule.pattern instanceof RegExp);
    // A guard that only says no teaches people to silence it.
    assert.ok(rule.fix && rule.fix.length > 10, `${rule.name} needs a usable fix line`);
  }
});
