import assert from "node:assert/strict";
import test from "node:test";

import worker from "./worker.js";

const env = {
  ALLOWED_ORIGIN: "https://example.com",
  GITHUB_BRANCH: "main",
  GITHUB_OWNER: "owner",
  GITHUB_REPO: "repo",
  GITHUB_TOKEN: "github-token",
  GOOGLE_CLIENT_ID: "google-client-id",
};

function githubContent(value, sha = "sha") {
  return { sha, content: Buffer.from(JSON.stringify(value)).toString("base64") };
}

async function register(body, calls) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init.method || "GET";
    calls.push({ url, method, body: init.body });
    if (url.hostname === "oauth2.googleapis.com") {
      return Response.json({ aud: env.GOOGLE_CLIENT_ID, email: "new@example.com", email_verified: "true", name: "New" });
    }
    if (method === "GET" && url.pathname.endsWith("/contents/users.json")) {
      return Response.json(githubContent({}));
    }
    if (method === "GET") return new Response("not found", { status: 404 });
    if (method === "PUT") return Response.json({ content: { sha: "new-sha" } });
    throw new Error(`Unexpected request: ${method} ${url}`);
  };
  try {
    return await worker.fetch(new Request("https://worker.example/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: "google-token", company: "협력사", adminName: "관리자", phone: "010-1234-5678", ...body }),
    }), env);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("registration stores an included signature and links it to the pending user", async () => {
  const calls = [];
  const response = await register({ imageBase64: "data:image/png;base64,aGVsbG8=" }, calls);
  assert.equal(response.status, 200);

  const puts = calls.filter(({ method }) => method === "PUT");
  const signaturePut = puts.find(({ url }) => decodeURIComponent(url.pathname).endsWith("/contents/signatures/new_example_com.png"));
  assert.ok(signaturePut);
  assert.equal(JSON.parse(signaturePut.body).content, "aGVsbG8=");

  const usersPut = puts.find(({ url }) => url.pathname.endsWith("/contents/users.json"));
  const users = JSON.parse(Buffer.from(JSON.parse(usersPut.body).content, "base64").toString());
  assert.equal(users["new@example.com"].status, "pending");
  assert.equal(users["new@example.com"].signatureUrl, "signatures/new_example_com.png");
});

test("registration remains compatible when older clients omit a signature", async () => {
  const calls = [];
  const response = await register({}, calls);
  assert.equal(response.status, 200);
  assert.equal(calls.some(({ url }) => url.pathname.includes("/contents/signatures/")), false);
});

test("registration rejects an invalid signature before changing stored user data", async () => {
  const calls = [];
  const response = await register({ imageBase64: "not-an-image" }, calls);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "PNG 또는 JPG 형식의 서명 이미지를 등록해주세요." });
  assert.equal(calls.some(({ method }) => method === "PUT"), false);
});
