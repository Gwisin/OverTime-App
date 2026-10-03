import assert from "node:assert/strict";
import test from "node:test";

import worker from "./worker.js";

const env = {
  ADMIN_EMAILS: "admin@example.com",
  ALLOWED_ORIGIN: "https://example.com",
  GITHUB_BRANCH: "main",
  GITHUB_OWNER: "owner",
  GITHUB_REPO: "repo",
  GITHUB_TOKEN: "github-token",
  GOOGLE_CLIENT_ID: "google-client-id",
};

const approvedUsers = {
  "vendor@example.com": { name: "Vendor", company: "협력사", org: "vendor", status: "approved" },
  "other@example.com": { name: "Other", company: "다른협력사", org: "vendor", status: "approved" },
  "hyundai@example.com": { name: "Hyundai", company: "현대건설(주)", org: "hyundai", status: "approved", signatureUrl: "signatures/hyundai.png" },
  "admin@example.com": { name: "Admin", company: "협력사", org: "vendor", status: "approved", signatureUrl: "signatures/admin.png" },
};

function githubContent(value, sha = "sha") {
  return { sha, content: Buffer.from(JSON.stringify(value)).toString("base64") };
}

function mockExternalRequests({ email = "vendor@example.com", users = approvedUsers, files = {} } = {}) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init.method || (typeof input === "string" ? "GET" : input.method) || "GET";
    calls.push({ url, method });

    if (url.hostname === "oauth2.googleapis.com") {
      return Response.json({ aud: env.GOOGLE_CLIENT_ID, email, email_verified: "true", name: email });
    }

    if (url.hostname === "api.github.com") {
      const marker = "/contents/";
      const path = url.pathname.slice(url.pathname.indexOf(marker) + marker.length)
        .split("/")
        .map(decodeURIComponent)
        .join("/");
      if (method === "GET") {
        if (path === "users.json") return Response.json(githubContent(users, "users-sha"));
        if (Object.hasOwn(files, path)) return Response.json(githubContent(files[path], `${path}-sha`));
        return new Response("not found", { status: 404 });
      }
      if (method === "PUT" || method === "DELETE") return Response.json({ content: { sha: "new-sha" } });
    }

    throw new Error(`Unexpected external request: ${method} ${url}`);
  };
  return { calls, fetch };
}

async function request(path, { method = "GET", body, token = "google-token" } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(new Request(`https://worker.example${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
}

async function withMockFetch(options, callback) {
  const originalFetch = globalThis.fetch;
  const mock = mockExternalRequests(options);
  globalThis.fetch = mock.fetch;
  try {
    await callback(mock.calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("protected APIs reject unauthenticated requests with 401", async () => {
  await withMockFetch({}, async (calls) => {
    const response = await request("/api/plans", { token: null });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "로그인이 필요합니다." });
    assert.equal(calls.length, 0);
  });
});

test("protected APIs reject every non-approved account state with 403", async () => {
  for (const status of ["pending", "rejected", "suspended", "unexpected"]) {
    const users = { "blocked@example.com": { name: "Blocked", company: "협력사", org: "vendor", status } };
    await withMockFetch({ email: "blocked@example.com", users }, async () => {
      const response = await request("/api/plans");
      assert.equal(response.status, 403, status);
      assert.deepEqual(await response.json(), { error: "승인되지 않은 계정입니다." });
    });
  }
});

test("vendor cannot access signup approval or ADMIN routes", async () => {
  await withMockFetch({}, async () => {
    assert.equal((await request("/api/users/pending")).status, 403);
    assert.equal((await request("/api/users/approve", { method: "POST", body: { email: "new@example.com", approve: true } })).status, 403);
    assert.equal((await request("/api/admin/users")).status, 403);
  });
});

test("Hyundai can review signups but cannot use ADMIN routes", async () => {
  await withMockFetch({ email: "hyundai@example.com" }, async () => {
    const pending = await request("/api/users/pending");
    assert.equal(pending.status, 200);
    assert.equal((await request("/api/admin/users")).status, 403);
  });
});

test("ADMIN can review signups and use ADMIN routes even with a vendor record", async () => {
  await withMockFetch({ email: "admin@example.com" }, async () => {
    assert.equal((await request("/api/users/pending")).status, 200);
    assert.equal((await request("/api/admin/users")).status, 200);
  });
});

test("vendor cannot submit another company's plan or approve and reject plans", async () => {
  const files = {
    "data/plans/other-plan.json": { id: "other-plan", company: "다른협력사", status: "draft", writerEmail: "other@example.com" },
  };
  await withMockFetch({ files }, async () => {
    assert.equal((await request("/api/plans/other-plan/submit", { method: "POST" })).status, 403);
    assert.equal((await request("/api/plans/other-plan/approve", { method: "POST", body: {} })).status, 403);
    assert.equal((await request("/api/plans/other-plan/reject", { method: "POST", body: { reason: "reason" } })).status, 403);
  });
});

test("Hyundai can submit draft plans, but approval and rejection require pending status", async () => {
  const files = {
    "data/plans/draft-plan.json": { id: "draft-plan", company: "협력사", status: "draft", writerEmail: "vendor@example.com" },
    "data/index.json": [],
  };
  await withMockFetch({ email: "hyundai@example.com", files }, async () => {
    assert.equal((await request("/api/plans/draft-plan/submit", { method: "POST" })).status, 200);
    assert.equal((await request("/api/plans/draft-plan/approve", { method: "POST", body: {} })).status, 400);
    assert.equal((await request("/api/plans/draft-plan/reject", { method: "POST", body: { reason: "reason" } })).status, 400);
  });
});

test("plan routes reject path traversal and control-character IDs before GitHub plan access", async () => {
  const unsafeIds = ["%2Fetc", "%5Cetc", "%00etc", "a".repeat(201)];
  for (const id of unsafeIds) {
    await withMockFetch({}, async (calls) => {
      const response = await request(`/api/plans/${id}`);
      assert.equal(response.status, 400, id);
      assert.equal(calls.filter(({ url }) => url.hostname === "api.github.com").length, 1, id);
    });
  }
});

test("approved plans cannot be deleted by vendor, Hyundai, or ADMIN", async () => {
  const files = {
    "data/plans/approved-plan.json": {
      id: "approved-plan",
      company: "협력사",
      status: "approved",
      writerEmail: "vendor@example.com",
    },
  };
  for (const email of ["vendor@example.com", "hyundai@example.com", "admin@example.com"]) {
    await withMockFetch({ email, files }, async (calls) => {
      const response = await request("/api/plans/approved-plan", { method: "DELETE" });
      assert.equal(response.status, 400, email);
      assert.equal(calls.some(({ method }) => method === "DELETE"), false, email);
    });
  }
});
