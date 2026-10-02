import assert from "node:assert/strict";
import test from "node:test";

import { accountStatusOf } from "./worker.js";

test("classifies supported account statuses", () => {
  assert.equal(accountStatusOf(null), "not_registered");
  assert.equal(accountStatusOf(undefined), "not_registered");

  for (const status of ["pending", "rejected", "suspended", "approved"]) {
    assert.equal(accountStatusOf({ status }), status);
  }
});

test("does not treat role-like or malformed values as approval", () => {
  assert.equal(accountStatusOf({}), "invalid");
  assert.equal(accountStatusOf({ status: "hyundai", org: "hyundai" }), "invalid");
  assert.equal(accountStatusOf({ status: "vendor", org: "vendor" }), "invalid");
  assert.equal(accountStatusOf({ status: "APPROVED" }), "invalid");
});
