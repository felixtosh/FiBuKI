import test from "node:test";
import assert from "node:assert/strict";
import {
  getArrowNavigationStep,
  isOverlayOpen,
  isTypingTarget,
} from "../lib/navigation/arrow-key-navigation.js";

const keydown = (key, target = { tagName: "DIV" }, modifiers = {}) => ({
  key,
  target,
  ...modifiers,
});

test("getArrowNavigationStep: left is previous, right is next", () => {
  assert.equal(getArrowNavigationStep(keydown("ArrowLeft")), -1);
  assert.equal(getArrowNavigationStep(keydown("ArrowRight")), 1);
});

test("getArrowNavigationStep: up and down stay unbound", () => {
  assert.equal(getArrowNavigationStep(keydown("ArrowUp")), null);
  assert.equal(getArrowNavigationStep(keydown("ArrowDown")), null);
  assert.equal(getArrowNavigationStep(keydown("j")), null);
});

test("getArrowNavigationStep: typing into a field keeps the key", () => {
  for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
    assert.equal(getArrowNavigationStep(keydown("ArrowRight", { tagName })), null);
  }
  assert.equal(
    getArrowNavigationStep(keydown("ArrowRight", { tagName: "DIV", isContentEditable: true })),
    null
  );
});

test("getArrowNavigationStep: a modified arrow belongs to the browser", () => {
  for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) {
    assert.equal(getArrowNavigationStep(keydown("ArrowLeft", { tagName: "DIV" }, { [modifier]: true })), null);
  }
});

test("getArrowNavigationStep: no event, no step", () => {
  assert.equal(getArrowNavigationStep(null), null);
  assert.equal(getArrowNavigationStep(undefined), null);
});

test("isTypingTarget: a plain element is not a typing target", () => {
  assert.equal(isTypingTarget({ tagName: "DIV" }), false);
  assert.equal(isTypingTarget({ tagName: "BUTTON" }), false);
  assert.equal(isTypingTarget(null), false);
});

test("isOverlayOpen: true while a portalled surface is mounted", () => {
  const doc = (match) => ({ querySelector: () => match });
  assert.equal(isOverlayOpen(doc({})), true);
  assert.equal(isOverlayOpen(doc(null)), false);
});

test("isOverlayOpen: a document that cannot be queried blocks nothing", () => {
  assert.equal(isOverlayOpen(null), false);
  assert.equal(isOverlayOpen({}), false);
});
