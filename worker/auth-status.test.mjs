import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workerUrl = new URL("./worker.v1.4.0.js", import.meta.url);
const workerSource = await readFile(workerUrl, "utf8");
const workerModule = await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString("base64")}`);
const { accountStatusOf } = workerModule;

assert.equal(accountStatusOf(null), "not_registered");
assert.equal(accountStatusOf(undefined), "not_registered");

for (const status of ["pending", "rejected", "suspended", "approved"]) {
  assert.equal(accountStatusOf({ status }), status);
}

assert.equal(accountStatusOf({}), "invalid");
assert.equal(accountStatusOf({ status: "hyundai", org: "hyundai" }), "invalid");
assert.equal(accountStatusOf({ status: "vendor", org: "vendor" }), "invalid");
assert.equal(accountStatusOf({ status: "APPROVED" }), "invalid");

console.log("accountStatusOf tests passed");
