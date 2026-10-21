import assert from "node:assert/strict";
import test from "node:test";
import { googleJwk, signedToken, keysResponse } from "./test-support/google-token.js";

const env = { GOOGLE_CLIENT_ID: "google-client-id", ALLOWED_ORIGIN: "https://example.com",
  GITHUB_OWNER: "owner", GITHUB_REPO: "repo", GITHUB_TOKEN: "test" };
let instance = 0;
async function freshWorker() { return (await import(`./worker.js?jwt-test=${++instance}`)).default; }
async function auth(worker, token) {
  return worker.fetch(new Request("https://worker.example/api/auth", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }),
  }), env);
}
async function mocked(callback, keys = () => keysResponse()) {
  const original = globalThis.fetch;
  const calls = [];
  let status = "approved";
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    if (String(input) === "https://www.googleapis.com/oauth2/v3/certs") return keys();
    if (String(input).includes("/contents/users.json")) return Response.json({ sha: "sha", content:
      Buffer.from(JSON.stringify({ "vendor@example.com": { status, name: "Vendor", company: "협력사", org: "vendor" } })).toString("base64") });
    assert.fail(`Unexpected external call: ${input}`);
  };
  try { await callback(calls, (value) => { status = value; }); }
  finally { globalThis.fetch = original; }
}

test("valid signed Google tokens reuse public keys while account status remains live", async () => {
  const worker = await freshWorker();
  await mocked(async (calls, setStatus) => {
    const first = await auth(worker, signedToken());
    assert.equal(first.status, 200);
    assert.equal((await first.json()).status, "approved");
    assert.match(first.headers.get("Server-Timing"), /google_keys;dur=/);
    assert.match(first.headers.get("Server-Timing"), /auth;dur=/);
    setStatus("suspended");
    assert.equal((await (await auth(worker, signedToken())).json()).status, "suspended");
    assert.equal(calls.filter((url) => url.includes("/certs")).length, 1);
    assert.equal(calls.filter((url) => url.includes("users.json")).length, 2);
    assert.equal(calls.some((url) => url.includes("tokeninfo")), false);
  });
});

test("invalid claims, algorithms, encodings and signatures cannot read user data", async () => {
  const worker = await freshWorker();
  const valid = signedToken();
  const [header, payload, signature] = valid.split(".");
  const badSignature = Buffer.from(signature, "base64url"); badSignature[0] ^= 1;
  const forgedPayload = Buffer.from(JSON.stringify({ email: "admin@example.com" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const invalid = [
    "google-token", "a.b.c", "null.null.null", valid + ".extra",
    signedToken(undefined, { aud: "another-client" }), signedToken(undefined, { iss: "https://attacker.example" }),
    signedToken(undefined, { exp: now - 1 }), signedToken(undefined, { exp: String(now + 3600) }),
    signedToken(undefined, { iat: now + 3600 }), signedToken(undefined, { nbf: now + 3600 }),
    signedToken(undefined, { email_verified: false }), signedToken(undefined, { sub: "" }),
    signedToken(undefined, {}, { alg: "none" }), signedToken(undefined, {}, { alg: "HS256" }),
    signedToken(undefined, {}, { kid: "" }), signedToken(undefined, {}, { crit: ["unsupported"] }),
    `${header}.${payload}.${badSignature.toString("base64url")}`, `${header}.${forgedPayload}.${signature}`,
    signedToken(undefined, {}, { kid: "unknown-key" }),
  ];
  await mocked(async (calls) => {
    for (const token of invalid) assert.equal((await auth(worker, token)).status, 401);
    assert.equal(calls.some((url) => url.includes("users.json")), false);
    assert.equal(calls.filter((url) => url.includes("/certs")).length, 1);
  });
});

test("concurrent requests share a key lookup and accept both Google issuers", async () => {
  const worker = await freshWorker();
  await mocked(async (calls) => {
    const responses = await Promise.all([
      auth(worker, signedToken()), auth(worker, signedToken(undefined, { iss: "accounts.google.com" })),
    ]);
    assert.ok(responses.every((response) => response.status === 200));
    assert.equal(calls.filter((url) => url.includes("/certs")).length, 1);
  });
});

test("key lookup failures fail closed and can recover on retry", async () => {
  const worker = await freshWorker();
  let fail = true;
  const originalError = console.error;
  console.error = () => {};
  try {
    await mocked(async (calls) => {
      assert.equal((await auth(worker, signedToken())).status, 500);
      assert.equal(calls.some((url) => url.includes("users.json")), false);
      fail = false;
      assert.equal((await auth(worker, signedToken())).status, 200);
    }, () => fail ? new Response("unavailable", { status: 503 }) : keysResponse());
  } finally { console.error = originalError; }
});

test("expired key cache and rotated key IDs trigger a fresh lookup", async () => {
  for (const rotation of [false, true]) {
    const worker = await freshWorker();
    const originalNow = Date.now;
    const now = originalNow();
    let elapsed = 0;
    Date.now = () => now + elapsed;
    try {
      await mocked(async (calls) => {
        assert.equal((await auth(worker, signedToken())).status, 200);
        elapsed = rotation ? 61000 : 3601000;
        const token = signedToken(undefined, {}, rotation ? { kid: "rotated" } : {});
        assert.equal((await auth(worker, token)).status, 200);
        assert.equal(calls.filter((url) => url.includes("/certs")).length, 2);
      }, () => keysResponse([{ ...googleJwk, kid: rotation && elapsed ? "rotated" : googleJwk.kid }]));
    } finally { Date.now = originalNow; }
  }
});

test("app sessions survive Google expiry, restore without renewal and expire exactly at KST midnight", async () => {
  const worker = await freshWorker();
  const originalNow = Date.now;
  const originalSecret = env.SESSION_SECRET;
  env.SESSION_SECRET = "test-only-session-secret-at-least-32-bytes";
  let now = Date.parse("2026-10-21T00:00:00Z"); // 09:00 KST
  Date.now = () => now;
  const requestAuth = (body) => worker.fetch(new Request("https://worker.example/api/auth", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), env);
  const protectedRequest = (token) => worker.fetch(new Request("https://worker.example/api/users/pending", {
    headers: { Authorization: `Bearer ${token}` },
  }), env);
  try {
    await mocked(async (calls, setStatus) => {
      const google = signedToken();
      const response = await requestAuth({ idToken: google, issueSession: true });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      const { sessionToken, sessionExpiresAt } = await response.json();
      assert.equal(sessionExpiresAt, Date.parse("2026-10-21T15:00:00Z"));
      now += 2 * 3600000;
      assert.equal((await auth(worker, google)).status, 401);
      const restored = await auth(worker, sessionToken);
      assert.equal(restored.status, 200);
      assert.equal((await restored.json()).sessionToken, undefined);
      assert.equal((await requestAuth({ idToken: sessionToken, issueSession: true })).status, 401);
      // The identity is valid but vendor cannot use signup management.
      assert.equal((await protectedRequest(sessionToken)).status, 403);
      setStatus("suspended");
      assert.equal((await (await auth(worker, sessionToken)).json()).status, "suspended");
      assert.equal((await protectedRequest(sessionToken)).status, 403);
      setStatus("approved");
      now = sessionExpiresAt - 1;
      assert.equal((await auth(worker, sessionToken)).status, 200);
      now = sessionExpiresAt;
      assert.equal((await auth(worker, sessionToken)).status, 401);
      assert.equal((await protectedRequest(sessionToken)).status, 401);
    });
  } finally { Date.now = originalNow; env.SESSION_SECRET = originalSecret; }
});

test("app session tampering, wrong audience, wrong secret and missing setup fail closed", async () => {
  const worker = await freshWorker();
  const originalSecret = env.SESSION_SECRET;
  const originalError = console.error;
  console.error = () => {};
  const exchange = () => worker.fetch(new Request("https://worker.example/api/auth", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: signedToken(), issueSession: true }),
  }), env);
  try {
    await mocked(async () => {
      delete env.SESSION_SECRET;
      assert.equal((await exchange()).status, 503);
      env.SESSION_SECRET = "test-only-session-secret-at-least-32-bytes";
      const { sessionToken } = await (await exchange()).json();
      const parts = sessionToken.split(".");
      const forged = { ...JSON.parse(Buffer.from(parts[1], "base64url")), email: "admin@example.com" };
      assert.equal((await auth(worker, `${parts[0]}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${parts[2]}`)).status, 401);
      const originalClient = env.GOOGLE_CLIENT_ID;
      env.GOOGLE_CLIENT_ID = "other-client";
      try { assert.equal((await auth(worker, sessionToken)).status, 401); }
      finally { env.GOOGLE_CLIENT_ID = originalClient; }
      env.SESSION_SECRET = "another-test-only-secret-at-least-32-bytes";
      assert.equal((await auth(worker, sessionToken)).status, 401);
      assert.equal((await auth(worker, "ot1.bad.encoding.extra")).status, 401);
    });
  } finally { env.SESSION_SECRET = originalSecret; console.error = originalError; }
});
