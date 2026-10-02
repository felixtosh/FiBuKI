import test from "node:test";
import assert from "node:assert/strict";
import { rememberableQuery, queryToRestore } from "../lib/filters/remembered-query.js";

test("rememberableQuery keeps filters and search, drops row and overlay params, sorts", () => {
  assert.equal(rememberableQuery("?type=expense&id=f1&search=ikea&connect=true"), "search=ikea&type=expense");
  assert.equal(rememberableQuery("id=f1"), "");
  assert.equal(rememberableQuery(""), "");
});

test("queryToRestore restores onto a bare list", () => {
  assert.equal(queryToRestore("", "type=expense"), "type=expense");
});

test("queryToRestore leaves an explicit filter alone", () => {
  assert.equal(queryToRestore("?partner=unmatched", "type=expense"), null);
});

test("queryToRestore leaves a deep link to a row alone, so the row stays visible", () => {
  assert.equal(queryToRestore("?id=f1", "type=expense"), null);
  assert.equal(queryToRestore("?invoiceId=i1", "type=expense"), null);
});

test("queryToRestore has nothing to restore when nothing was remembered", () => {
  assert.equal(queryToRestore("", ""), null);
  assert.equal(queryToRestore("", null), null);
});
