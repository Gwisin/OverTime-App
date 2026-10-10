import assert from "node:assert/strict";
import test from "node:test";

import worker from "./worker.js";
import { signedToken, keysResponse } from "./test-support/google-token.js";
let activeToken = signedToken();

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
  "vendor@example.com": { name: "Vendor", company: "협력사", org: "vendor", phone: "010-1234-5678", status: "approved" },
  "other@example.com": { name: "Other", company: "다른협력사", org: "vendor", status: "approved" },
  "hyundai@example.com": { name: "Hyundai", company: "현대건설(주)", org: "hyundai", status: "approved", signatureUrl: "signatures/hyundai.png" },
  "admin@example.com": { name: "Admin", company: "협력사", org: "vendor", status: "approved", signatureUrl: "signatures/admin.png" },
};

test("manager lookup masks contact details for non-ADMIN users", async () => {
  await withMockFetch({}, async () => {
    const response = await request("/api/managers?org=vendor&company=" + encodeURIComponent("협력사"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      managers: [{ email: "", name: "Vendor", company: "협력사", phone: "" }],
    });
  });
});

test("manager lookup returns contact details to ADMIN users", async () => {
  await withMockFetch({ email: "admin@example.com" }, async () => {
    const response = await request("/api/managers?org=vendor&company=" + encodeURIComponent("협력사"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      managers: [{ email: "vendor@example.com", name: "Vendor", company: "협력사", phone: "010-1234-5678" }],
    });
  });
});

test("protected handlers reuse the users file loaded for authorization", async () => {
  await withMockFetch({}, async (calls) => {
    const response = await request("/api/managers?org=vendor&company=" + encodeURIComponent("협력사"));
    assert.equal(response.status, 200);
    const usersGets = calls.filter(({ method, url }) =>
      method === "GET" && decodeURIComponent(url.pathname).endsWith("/contents/users.json")
    );
    assert.equal(usersGets.length, 1);
  });
});

function githubContent(value, sha = "sha") {
  return { sha, content: Buffer.from(JSON.stringify(value)).toString("base64") };
}

function mockExternalRequests({ email = "vendor@example.com", users = approvedUsers, files = {}, rawFiles = {} } = {}) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init.method || (typeof input === "string" ? "GET" : input.method) || "GET";
    calls.push({ url, method, body: init.body });

    if (url.href === "https://www.googleapis.com/oauth2/v3/certs") return keysResponse();

    if (url.hostname === "api.github.com") {
      const marker = "/contents/";
      const path = url.pathname.slice(url.pathname.indexOf(marker) + marker.length)
        .split("/")
        .map(decodeURIComponent)
        .join("/");
      if (method === "GET") {
        if (path === "users.json") return Response.json(githubContent(users, "users-sha"));
        if (Object.hasOwn(rawFiles, path)) return new Response(rawFiles[path]);
        if (Object.hasOwn(files, path)) return Response.json(githubContent(files[path], `${path}-sha`));
        return new Response("not found", { status: 404 });
      }
      if (method === "PUT" || method === "DELETE") return Response.json({ content: { sha: "new-sha" } });
    }

    throw new Error(`Unexpected external request: ${method} ${url}`);
  };
  return { calls, fetch };
}

async function request(path, { method = "GET", body, token = activeToken, origin } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (origin) headers.Origin = origin;
  return worker.fetch(new Request(`https://worker.example${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
}

async function withMockFetch(options, callback) {
  const originalFetch = globalThis.fetch;
  const previousToken = activeToken;
  activeToken = signedToken(options.email || "vendor@example.com");
  const mock = mockExternalRequests(options);
  globalThis.fetch = mock.fetch;
  try {
    await callback(mock.calls);
  } finally {
    globalThis.fetch = originalFetch;
    activeToken = previousToken;
  }
}

test("Hyundai and ADMIN can approve or reject pending registrations without changing profile data", async () => {
  const pending = { name: "Applicant", company: "협력사", status: "pending", signatureUrl: "signatures/applicant.png", createdAt: "2026-10-01T00:00:00.000Z" };
  for (const email of ["hyundai@example.com", "admin@example.com"]) {
    for (const approve of [true, false]) {
      const users = { ...approvedUsers, "applicant@example.com": pending };
      await withMockFetch({ email, users }, async (calls) => {
        const response = await request("/api/users/approve", { method: "POST", body: { email: "applicant@example.com", approve } });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true });
        const puts = calls.filter(({ method }) => method === "PUT");
        assert.equal(puts.length, 1);
        const saved = JSON.parse(Buffer.from(JSON.parse(puts[0].body).content, "base64").toString());
        const applicant = saved["applicant@example.com"];
        assert.equal(applicant.status, approve ? "approved" : "rejected");
        assert.equal(applicant.approvedBy, email);
        assert.ok(Number.isFinite(Date.parse(applicant.approvedAt)));
        const { status, approvedBy, approvedAt, ...profile } = applicant;
        const { status: pendingStatus, ...originalProfile } = pending;
        assert.deepEqual(profile, originalProfile);
        assert.deepEqual(saved["admin@example.com"], approvedUsers["admin@example.com"]);
      });
    }
  }
});

test("registration decisions cannot change non-pending accounts", async () => {
  for (const email of ["hyundai@example.com", "admin@example.com"]) {
    for (const status of ["approved", "suspended", "rejected", "invalid", undefined]) {
      for (const approve of [true, false]) {
        const users = { ...approvedUsers, "target@example.com": { name: "Target", status } };
        await withMockFetch({ email, users }, async (calls) => {
          const response = await request("/api/users/approve", { method: "POST", body: { email: "target@example.com", approve } });
          assert.equal(response.status, 409);
          assert.equal((await response.json()).code, "INVALID_ACCOUNT_STATUS");
          assert.equal(calls.some(({ method }) => method === "PUT"), false);
        });
      }
    }
  }
});

test("registration decisions protect ADMIN targets even when pending", async () => {
  for (const email of ["hyundai@example.com", "admin@example.com"]) {
    for (const approve of [true, false]) {
      for (const target of ["admin@example.com", "ADMIN@example.com"]) {
        const users = { ...approvedUsers, [target]: { status: "pending" } };
        if (target === email) users[email] = approvedUsers[email];
        await withMockFetch({ email, users }, async (calls) => {
          const response = await request("/api/users/approve", { method: "POST", body: { email: target, approve } });
          assert.equal(response.status, 403);
          assert.equal((await response.json()).code, "ADMIN_ACCOUNT_PROTECTED");
          assert.equal(calls.some(({ method }) => method === "PUT"), false);
        });
      }
    }
  }
});

test("registration decisions reject non-boolean approve values without writing", async () => {
  for (const approve of ["true", "false", "", 0, 1, null, undefined, [], {}]) {
    const users = { ...approvedUsers, "applicant@example.com": { status: "pending" } };
    await withMockFetch({ email: "hyundai@example.com", users }, async (calls) => {
      const response = await request("/api/users/approve", { method: "POST", body: { email: "applicant@example.com", approve } });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "INVALID_APPROVAL");
      assert.equal(calls.some(({ method }) => method === "PUT"), false);
    });
  }
});

test("registration decisions reject malformed and missing targets without writing", async () => {
  for (const body of [null, {}, { email: 1, approve: true }, { email: [], approve: true }, { email: " ", approve: true }]) {
    await withMockFetch({ email: "hyundai@example.com" }, async (calls) => {
      const response = await request("/api/users/approve", { method: "POST", body });
      assert.equal(response.status, 400);
      assert.equal(calls.some(({ method }) => method === "PUT"), false);
    });
  }
  for (const email of ["missing@example.com", "__proto__", "constructor"]) {
    await withMockFetch({ email: "hyundai@example.com" }, async (calls) => {
      const response = await request("/api/users/approve", { method: "POST", body: { email, approve: true } });
      assert.equal(response.status, 404);
      assert.equal((await response.json()).code, "USER_NOT_FOUND");
      assert.equal(calls.some(({ method }) => method === "PUT"), false);
    });
  }
});

test("vendor cannot decide registrations and only ADMIN can reactivate suspended users", async () => {
  const users = { ...approvedUsers, "target@example.com": { status: "suspended" } };
  await withMockFetch({ users }, async (calls) => {
    assert.equal((await request("/api/users/approve", { method: "POST", body: { email: "target@example.com", approve: true } })).status, 403);
    assert.equal(calls.some(({ method }) => method === "PUT"), false);
  });
  for (const email of ["hyundai@example.com", "admin@example.com"]) {
    await withMockFetch({ email, users }, async (calls) => {
      const response = await request("/api/admin/users/status", { method: "POST", body: { email: "target@example.com", status: "approved" } });
      assert.equal(response.status, email === "admin@example.com" ? 200 : 403);
      assert.equal(calls.some(({ method }) => method === "PUT"), email === "admin@example.com");
    });
  }
});

test("registration decisions recheck pending status after a GitHub write conflict", async () => {
  const users = { ...approvedUsers, "target@example.com": { status: "pending" } };
  await withMockFetch({ email: "hyundai@example.com", users }, async () => {
    const mockFetch = globalThis.fetch;
    let writes = 0;
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/contents/users.json")) {
        if (init.method === "PUT") {
          writes++;
          return new Response("SHA conflict", { status: 409 });
        }
        if (writes) return Response.json(githubContent({ ...users, "target@example.com": { status: "suspended" } }, "updated-sha"));
      }
      return mockFetch(input, init);
    };
    const response = await request("/api/users/approve", { method: "POST", body: { email: "target@example.com", approve: true } });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "INVALID_ACCOUNT_STATUS");
    assert.equal(writes, 1);
  });
});

test("protected APIs reject unauthenticated requests with 401", async () => {
  await withMockFetch({}, async (calls) => {
    const response = await request("/api/plans", { token: null });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "로그인이 필요합니다." });
    assert.equal(calls.length, 0);
  });
});

test("vendors can browse all plan summaries but only open their own company details", async () => {
  const files = {
    "data/index.json": [
      { id: "own-plan", company: "협력사", status: "draft", workDate: "2026-10-06" },
      { id: "other-plan", company: "다른협력사", status: "approved", workDate: "2026-10-05" },
    ],
    "data/plans/own-plan.json": { id: "own-plan", company: "협력사", status: "draft" },
    "data/plans/other-plan.json": { id: "other-plan", company: "다른협력사", status: "approved", hazards: "private" },
  };
  await withMockFetch({ files }, async () => {
    const list = await request("/api/plans?scope=all");
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json()).plans.map(({ id }) => id), ["own-plan", "other-plan"]);
    assert.equal((await request("/api/plans/own-plan")).status, 200);
    const forbidden = await request("/api/plans/other-plan");
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).code, "PLAN_DETAIL_FORBIDDEN");
  });
});

test("plan list GET does not backfill legacy summaries or write stored data", async () => {
  const legacySummary = { id: "legacy-plan", company: "협력사", status: "approved", workDate: "2026-10-01" };
  const files = {
    "data/index.json": [legacySummary],
    "data/plans/legacy-plan.json": {
      ...legacySummary,
      writerName: "Legacy Writer",
      approval: { approverName: "Legacy Approver" },
    },
  };
  await withMockFetch({ files }, async (calls) => {
    const response = await request("/api/plans");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { plans: [legacySummary] });
    assert.equal(calls.some(({ method }) => method === "PUT" || method === "DELETE"), false);
    assert.equal(calls.some(({ url }) => decodeURIComponent(url.pathname).endsWith("/contents/data/plans/legacy-plan.json")), false);
  });
});

test("Hyundai and ADMIN can open every company plan detail", async () => {
  const files = { "data/plans/other-plan.json": { id: "other-plan", company: "다른협력사", status: "approved" } };
  for (const email of ["hyundai@example.com", "admin@example.com"]) {
    await withMockFetch({ email, files }, async () => {
      assert.equal((await request("/api/plans/other-plan")).status, 200, email);
    });
  }
});

test("plan signature lookup follows plan detail permissions", async () => {
  const plan = {
    id: "signed-plan",
    company: "다른협력사",
    status: "approved",
    writerEmail: "other@example.com",
    executionReview: { signatureUrl: "signatures/execution.png" },
    safetyApproval: { signatureUrl: "signatures/safety.png" },
  };
  const users = {
    ...approvedUsers,
    "other@example.com": { ...approvedUsers["other@example.com"], signatureUrl: "signatures/vendor.png" },
  };
  const files = { "data/plans/signed-plan.json": plan };
  const rawFiles = {
    "signatures/vendor.png": "vendor",
    "signatures/execution.png": "execution",
    "signatures/safety.png": "safety",
  };

  await withMockFetch({ users, files, rawFiles }, async (calls) => {
    const response = await request("/api/plans/signed-plan/signatures");
    assert.equal(response.status, 403);
    assert.equal(calls.some(({ url }) => decodeURIComponent(url.pathname).includes("/contents/signatures/")), false);
  });

  for (const email of ["other@example.com", "hyundai@example.com", "admin@example.com"]) {
    await withMockFetch({ email, users, files, rawFiles }, async () => {
      const response = await request("/api/plans/signed-plan/signatures");
      assert.equal(response.status, 200, email);
      const { signatures } = await response.json();
      assert.match(signatures.vendor, /^data:image\/png;base64,/);
      assert.match(signatures.execution, /^data:image\/png;base64,/);
      assert.match(signatures.safety, /^data:image\/png;base64,/);
    });
  }
});

test("CORS allows configured origins and rejects every other browser origin", async () => {
  await withMockFetch({}, async (calls) => {
    const allowed = await request("/api/companies", { token: null, origin: "https://example.com" });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "https://example.com");
    assert.equal(allowed.headers.get("Vary"), "Origin");

    const callsBeforeRejectedRequest = calls.length;
    const rejected = await request("/api/companies", { token: null, origin: "https://evil.example" });
    assert.equal(rejected.status, 403);
    assert.deepEqual(await rejected.json(), { error: "허용되지 않은 요청 출처입니다.", code: "ORIGIN_NOT_ALLOWED" });
    assert.equal(calls.length, callsBeforeRejectedRequest);
  });
});

test("CORS fails closed for browser requests when ALLOWED_ORIGIN is missing", async () => {
  const response = await worker.fetch(new Request("https://worker.example/api/companies", {
    headers: { Origin: "https://example.com" },
  }), { ...env, ALLOWED_ORIGIN: "" });
  assert.equal(response.status, 403);
  assert.equal(response.headers.has("Access-Control-Allow-Origin"), false);
});

test("test-login tokens are not accepted without Google verification", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "oauth2.googleapis.com") return new Response("invalid token", { status: 401 });
    throw new Error(`Unexpected external request: ${url}`);
  };
  try {
    const response = await request("/api/auth", {
      method: "POST",
      token: null,
      body: { idToken: "TEST::secret::admin@example.com::Admin" },
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "로그인 정보를 확인할 수 없습니다." });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("JSON request limits reject oversized bodies before external API calls", async () => {
  await withMockFetch({}, async (calls) => {
    const response = await request("/api/auth", {
      method: "POST",
      token: null,
      body: { idToken: "x".repeat(70 * 1024) },
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "요청 데이터가 너무 큽니다.", code: "REQUEST_TOO_LARGE" });
    assert.equal(calls.length, 0);
  });
});

test("plan validation rejects impossible dates and oversized fields", async () => {
  await withMockFetch({}, async (calls) => {
    const invalidDate = await request("/api/plans", {
      method: "POST",
      body: { workDate: "2026-02-31", company: "협력사", workType: "야간" },
    });
    assert.equal(invalidDate.status, 400);
    assert.equal((await invalidDate.json()).code, "INVALID_DATE");

    const oversizedField = await request("/api/plans", {
      method: "POST",
      body: { workDate: "2026-10-05", company: "협력사", workType: "야간", hazards: "x".repeat(5001) },
    });
    assert.equal(oversizedField.status, 400);
    assert.equal((await oversizedField.json()).code, "INVALID_INPUT");
    assert.equal(calls.some(({ method }) => method === "PUT"), false);
  });
});

test("internal upstream errors do not expose GitHub response details", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.href === "https://www.googleapis.com/oauth2/v3/certs") return keysResponse();
    if (url.hostname === "api.github.com") return new Response("private repository detail", { status: 500 });
    throw new Error(`Unexpected external request: ${url}`);
  };
  console.error = () => {};
  try {
    const response = await request("/api/plans");
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error, "서버 요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.");
    assert.equal(body.code, "INTERNAL_ERROR");
    assert.equal(typeof body.requestId, "string");
    assert.doesNotMatch(JSON.stringify(body), /private repository detail|users\.json/);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test("plan signature API returns vendor request, review, and approval images", async () => {
  const users = {
    ...approvedUsers,
    "vendor@example.com": { ...approvedUsers["vendor@example.com"], signatureUrl: "signatures/vendor.png" },
  };
  const files = {
    "data/plans/signed-plan.json": {
      id: "signed-plan",
      status: "approved",
      writerEmail: "vendor@example.com",
      executionReview: { signatureUrl: "signatures/reviewer.png" },
      safetyApproval: { signatureUrl: "signatures/approver.jpg" },
    },
  };
  const rawFiles = {
    "signatures/vendor.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]),
    "signatures/reviewer.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    "signatures/approver.jpg": Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  };
  await withMockFetch({ users, files, rawFiles }, async () => {
    const response = await request("/api/plans/signed-plan/signatures");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      signatures: {
        vendor: "data:image/png;base64,iVBORwE=",
        execution: "data:image/png;base64,iVBORw==",
        safety: "data:image/jpeg;base64,/9j/4A==",
      },
    });
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

test("ADMIN name changes update every email-linked plan role and its list summary", async () => {
  const files = {
    "data/index.json": [
      {
        id: "linked-plan",
        status: "approved",
        writerName: "Vendor",
        vendorManagerName: "Vendor",
        hyundaiManagerName: "Vendor",
        approverName: "Vendor",
      },
      { id: "same-name-plan", status: "draft", writerName: "Vendor" },
    ],
    "data/plans/linked-plan.json": {
      id: "linked-plan",
      status: "approved",
      writerEmail: "vendor@example.com",
      writerName: "Vendor",
      vendorManagerEmail: "vendor@example.com",
      vendorManagerName: "Vendor",
      hyundaiManagerEmail: "vendor@example.com",
      hyundaiManagerName: "Vendor",
      approval: {
        approverEmail: "vendor@example.com",
        approverName: "Vendor",
        approvedAt: "2026-01-01T00:00:00.000Z",
        signatureUrl: "signatures/vendor.png",
      },
    },
    "data/plans/same-name-plan.json": {
      id: "same-name-plan",
      status: "draft",
      writerEmail: "other@example.com",
      writerName: "Vendor",
    },
  };

  await withMockFetch({ email: "admin@example.com", files }, async (calls) => {
    const response = await request("/api/admin/rename-user", {
      method: "POST",
      body: { email: "vendor@example.com", name: "새 이름", cursor: 0 },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      plansUpdated: 1,
      remaining: 0,
      nextCursor: 2,
      userUpdated: true,
    });

    const puts = calls.filter(({ method }) => method === "PUT");
    const putJson = (path) => {
      const call = puts.find(({ url }) => decodeURIComponent(url.pathname).endsWith(`/contents/${path}`));
      assert.ok(call, `missing PUT for ${path}`);
      const payload = JSON.parse(call.body);
      return JSON.parse(Buffer.from(payload.content, "base64").toString());
    };
    const plan = putJson("data/plans/linked-plan.json");
    assert.equal(plan.writerName, "새 이름");
    assert.equal(plan.vendorManagerName, "새 이름");
    assert.equal(plan.hyundaiManagerName, "새 이름");
    assert.equal(plan.approval.approverName, "새 이름");
    assert.equal(plan.approval.approvedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(plan.approval.signatureUrl, "signatures/vendor.png");

    const index = putJson("data/index.json");
    assert.deepEqual(
      [index[0].writerName, index[0].vendorManagerName, index[0].hyundaiManagerName, index[0].approverName],
      ["새 이름", "새 이름", "새 이름", "새 이름"]
    );
    assert.equal(index[1].writerName, "Vendor");
    assert.equal(puts.some(({ url }) => decodeURIComponent(url.pathname).endsWith("/data/plans/same-name-plan.json")), false);
    assert.equal(putJson("users.json")["vendor@example.com"].name, "새 이름");
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
    "data/plans/draft-plan.json": {
      id: "draft-plan",
      company: "협력사",
      status: "draft",
      writerEmail: "vendor@example.com",
      vendorManagerName: "현장소장",
    },
    "data/index.json": [],
  };
  await withMockFetch({ email: "hyundai@example.com", files }, async () => {
    assert.equal((await request("/api/plans/draft-plan/submit", { method: "POST" })).status, 200);
    assert.equal((await request("/api/plans/draft-plan/approve", { method: "POST", body: {} })).status, 400);
    assert.equal((await request("/api/plans/draft-plan/reject", { method: "POST", body: { reason: "reason" } })).status, 400);
  });
});

test("submission requires a vendor resident manager but does not require a Hyundai resident manager", async () => {
  const files = {
    "data/plans/missing-manager.json": { id: "missing-manager", company: "협력사", status: "draft", writerEmail: "vendor@example.com" },
    "data/plans/manual-manager.json": {
      id: "manual-manager",
      company: "협력사",
      status: "draft",
      writerEmail: "vendor@example.com",
      vendorManagerEmail: "",
      vendorManagerName: "  미가입 현장소장  ",
      hyundaiManagerEmail: "",
      hyundaiManagerName: "",
    },
    "data/index.json": [],
  };
  await withMockFetch({ files }, async (calls) => {
    const missing = await request("/api/plans/missing-manager/submit", { method: "POST" });
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { error: "협력업체 상주관리자를 선택하거나 직접 입력해주세요." });

    const submitted = await request("/api/plans/manual-manager/submit", { method: "POST" });
    assert.equal(submitted.status, 200);
    const planPut = calls.find(({ method, url }) => method === "PUT" && decodeURIComponent(url.pathname).endsWith("/data/plans/manual-manager.json"));
    const payload = JSON.parse(planPut.body);
    const saved = JSON.parse(Buffer.from(payload.content, "base64").toString());
    assert.equal(saved.vendorManagerName, "미가입 현장소장");
    assert.equal(calls.filter(({ method, url }) => method === "GET" && url.pathname.endsWith("/data/plans/manual-manager.json")).length, 1);
    assert.equal(saved.hyundaiManagerName, "");
  });
});

test("save accepts a manual vendor manager and ignores Hyundai manager fields before approval", async () => {
  const files = { "data/index.json": [] };
  await withMockFetch({ files }, async (calls) => {
    const response = await request("/api/plans", {
      method: "POST",
      body: {
        workDate: "2026-10-03",
        company: "협력사",
        workType: "점심",
        vendorManagerEmail: "",
        vendorManagerName: "  미가입 협력소장  ",
        hyundaiManagerEmail: "spoofed@hyundai.com",
        hyundaiManagerName: "작성자가 지정한 이름",
        unexpectedField: "저장되면 안 됨",
      },
    });
    assert.equal(response.status, 200);
    const planPut = calls.find(({ method, url }) => method === "PUT" && decodeURIComponent(url.pathname).includes("/data/plans/"));
    const payload = JSON.parse(planPut.body);
    const saved = JSON.parse(Buffer.from(payload.content, "base64").toString());
    assert.equal(saved.writerEmail, "vendor@example.com");
    assert.equal(saved.vendorManagerEmail, "");
    assert.equal(saved.vendorManagerName, "미가입 협력소장");
    assert.equal(saved.hyundaiManagerEmail, undefined);
    assert.equal(saved.hyundaiManagerName, undefined);
    assert.equal(saved.unexpectedField, undefined);
  });
});

test("save allowlist preserves omitted optional fields on existing plans", async () => {
  const files = {
    "data/index.json": [],
    "data/plans/existing-plan.json": {
      id: "existing-plan",
      workDate: "2026-10-03",
      company: "협력사",
      workType: "점심",
      workLocation: "기존 작업 위치",
      hazards: "기존 위험요인",
      status: "draft",
      writerEmail: "vendor@example.com",
      writerName: "Vendor",
      createdAt: "2026-10-01T00:00:00.000Z",
    },
  };
  await withMockFetch({ files }, async (calls) => {
    const response = await request("/api/plans", {
      method: "POST",
      body: { id: "existing-plan", workDate: "2026-10-03", company: "협력사", workType: "점심" },
    });
    assert.equal(response.status, 200);
    const planPut = calls.find(({ method, url }) => method === "PUT" && decodeURIComponent(url.pathname).endsWith("/data/plans/existing-plan.json"));
    const saved = JSON.parse(Buffer.from(JSON.parse(planPut.body).content, "base64").toString());
    assert.equal(saved.workLocation, "기존 작업 위치");
    assert.equal(saved.hazards, "기존 위험요인");
  });
});

test("safety approval saves the selected Hyundai resident manager before execution review", async () => {
  const files = {
    "data/plans/pending-plan.json": {
      id: "pending-plan",
      company: "협력사",
      status: "pending",
      writerEmail: "vendor@example.com",
      vendorManagerName: "협력소장",
    },
    "data/index.json": [{ id: "pending-plan", status: "pending" }],
  };
  await withMockFetch({ email: "hyundai@example.com", files }, async (calls) => {
    const response = await request("/api/plans/pending-plan/safety-approve", {
      method: "POST",
      body: { hyundaiManagerEmail: "manager@hyundai.com", hyundaiManagerName: "  현대 현장소장  " },
    });
    assert.equal(response.status, 200);
    const planPuts = calls.filter(({ method, url }) => method === "PUT" && decodeURIComponent(url.pathname).endsWith("/data/plans/pending-plan.json"));
    const payload = JSON.parse(planPuts.at(-1).body);
    const saved = JSON.parse(Buffer.from(payload.content, "base64").toString());
    assert.equal(saved.status, "pending");
    assert.equal(saved.hyundaiManagerEmail, "manager@hyundai.com");
    assert.equal(saved.hyundaiManagerName, "현대 현장소장");
    assert.equal(saved.safetyApproval.approverEmail, "hyundai@example.com");
    assert.equal(saved.approval, undefined);
  });
});

test("execution review saves the selected Hyundai resident manager", async () => {
  const files = {
    "data/plans/pending-plan.json": {
      id: "pending-plan",
      company: "협력사",
      status: "pending",
      writerEmail: "vendor@example.com",
      vendorManagerName: "협력소장",
    },
    "data/index.json": [{ id: "pending-plan", status: "pending" }],
  };
  await withMockFetch({ email: "hyundai@example.com", files }, async (calls) => {
    const response = await request("/api/plans/pending-plan/execution-review", {
      method: "POST",
      body: { hyundaiManagerEmail: "manager@hyundai.com", hyundaiManagerName: "  현대 현장소장  " },
    });
    assert.equal(response.status, 200);
    const planPuts = calls.filter(({ method, url }) => method === "PUT" && decodeURIComponent(url.pathname).endsWith("/data/plans/pending-plan.json"));
    const saved = JSON.parse(Buffer.from(JSON.parse(planPuts.at(-1).body).content, "base64").toString());
    assert.equal(saved.hyundaiManagerEmail, "manager@hyundai.com");
    assert.equal(saved.hyundaiManagerName, "현대 현장소장");
    assert.equal(saved.executionReview.reviewerEmail, "hyundai@example.com");
  });
});

test("legacy approve route still requires and saves a Hyundai resident manager", async () => {
  const files = {
    "data/plans/pending-plan.json": { id: "pending-plan", company: "협력사", status: "pending", writerEmail: "vendor@example.com" },
    "data/index.json": [{ id: "pending-plan", status: "pending" }],
  };
  await withMockFetch({ email: "hyundai@example.com", files }, async (calls) => {
    assert.equal((await request("/api/plans/pending-plan/approve", { method: "POST", body: {} })).status, 400);
    const response = await request("/api/plans/pending-plan/approve", {
      method: "POST",
      body: { hyundaiManagerEmail: "", hyundaiManagerName: "  미가입 현대소장  " },
    });
    assert.equal(response.status, 200);
    const planPuts = calls.filter(({ method, url }) => method === "PUT" && decodeURIComponent(url.pathname).endsWith("/data/plans/pending-plan.json"));
    const saved = JSON.parse(Buffer.from(JSON.parse(planPuts.at(-1).body).content, "base64").toString());
    assert.equal(saved.hyundaiManagerEmail, "");
    assert.equal(saved.hyundaiManagerName, "미가입 현대소장");
  });
});

test("execution review completes a prior safety approval and moves the plan to approved", async () => {
  const files = {
    "data/plans/pending-plan.json": {
      id: "pending-plan",
      company: "협력사",
      status: "pending",
      writerEmail: "vendor@example.com",
      safetyApproval: { approverEmail: "hyundai@example.com", approverName: "Hyundai", approvedAt: "2026-10-03T01:00:00.000Z" },
    },
    "data/index.json": [{ id: "pending-plan", status: "pending" }],
  };
  await withMockFetch({ email: "hyundai@example.com", files }, async (calls) => {
    const response = await request("/api/plans/pending-plan/execution-review", { method: "POST" });
    assert.equal(response.status, 200);
    const planPut = calls.find(({ method, url }) => method === "PUT" && decodeURIComponent(url.pathname).endsWith("/data/plans/pending-plan.json"));
    const saved = JSON.parse(Buffer.from(JSON.parse(planPut.body).content, "base64").toString());
    assert.equal(saved.status, "approved");
    assert.equal(saved.executionReview.reviewerEmail, "hyundai@example.com");
    assert.equal(saved.safetyApproval.approverName, "Hyundai");
    assert.equal(saved.approval.approverName, "Hyundai");
  });
});

test("execution review alone moves the plan to approving", async () => {
  const files = {
    "data/plans/pending-plan.json": { id: "pending-plan", company: "협력사", status: "pending", writerEmail: "vendor@example.com" },
    "data/index.json": [{ id: "pending-plan", status: "pending" }],
  };
  await withMockFetch({ email: "hyundai@example.com", files }, async (calls) => {
    assert.equal((await request("/api/plans/pending-plan/execution-review", { method: "POST" })).status, 200);
    const planPut = calls.find(({ method, url }) => method === "PUT" && decodeURIComponent(url.pathname).endsWith("/data/plans/pending-plan.json"));
    const saved = JSON.parse(Buffer.from(JSON.parse(planPut.body).content, "base64").toString());
    assert.equal(saved.status, "approving");
  });
});

test("rejection from either approval step resets all parallel approval records", async () => {
  const files = {
    "data/plans/approving-plan.json": {
      id: "approving-plan",
      company: "협력사",
      status: "approving",
      executionReview: { reviewerEmail: "hyundai@example.com", reviewerName: "Hyundai" },
      safetyApproval: { approverEmail: "hyundai@example.com", approverName: "Hyundai" },
      approval: { approverEmail: "hyundai@example.com", approverName: "Hyundai" },
    },
    "data/index.json": [{ id: "approving-plan", status: "approving" }],
  };
  await withMockFetch({ email: "hyundai@example.com", files }, async (calls) => {
    const response = await request("/api/plans/approving-plan/reject", { method: "POST", body: { stage: "safety", reason: "보완 필요" } });
    assert.equal(response.status, 200);
    const planPut = calls.find(({ method, url }) => method === "PUT" && decodeURIComponent(url.pathname).endsWith("/data/plans/approving-plan.json"));
    const saved = JSON.parse(Buffer.from(JSON.parse(planPut.body).content, "base64").toString());
    assert.equal(saved.status, "draft");
    assert.equal(saved.rejectedStage, "safety");
    assert.equal(saved.executionReview, undefined);
    assert.equal(saved.safetyApproval, undefined);
    assert.equal(saved.approval, undefined);
  });
});

test("only Hyundai can change the resident manager on an approved plan without altering approval data", async () => {
  const approval = {
    approverEmail: "hyundai@example.com",
    approverName: "Hyundai",
    signatureUrl: "signatures/hyundai.png",
    approvedAt: "2026-10-03T01:00:00.000Z",
  };
  const approvedPlan = {
    id: "approved-plan",
    company: "협력사",
    status: "approved",
    workLocation: "기존 작업내용",
    writerEmail: "vendor@example.com",
    hyundaiManagerEmail: "old@hyundai.com",
    hyundaiManagerName: "기존 관리자",
    approval,
  };
  const files = {
    "data/plans/approved-plan.json": approvedPlan,
    "data/plans/draft-plan.json": { ...approvedPlan, id: "draft-plan", status: "draft" },
    "data/index.json": [{ id: "approved-plan", status: "approved", hyundaiManagerName: "기존 관리자" }],
  };

  await withMockFetch({ files }, async (calls) => {
    const response = await request("/api/plans/approved-plan/hyundai-manager", {
      method: "POST",
      body: { hyundaiManagerEmail: "new@hyundai.com", hyundaiManagerName: "새 관리자" },
    });
    assert.equal(response.status, 403);
    assert.equal(calls.some(({ method }) => method === "PUT"), false);
  });

  await withMockFetch({ email: "hyundai@example.com", files }, async (calls) => {
    const wrongStatus = await request("/api/plans/draft-plan/hyundai-manager", {
      method: "POST",
      body: { hyundaiManagerEmail: "new@hyundai.com", hyundaiManagerName: "새 관리자" },
    });
    assert.equal(wrongStatus.status, 400);

    const response = await request("/api/plans/approved-plan/hyundai-manager", {
      method: "POST",
      body: { hyundaiManagerEmail: "NEW@HYUNDAI.COM", hyundaiManagerName: "  새 관리자  " },
    });
    assert.equal(response.status, 200);

    const planPut = calls.find(({ method, url }) => method === "PUT" && decodeURIComponent(url.pathname).endsWith("/data/plans/approved-plan.json"));
    const planPayload = JSON.parse(planPut.body);
    const savedPlan = JSON.parse(Buffer.from(planPayload.content, "base64").toString());
    assert.equal(savedPlan.hyundaiManagerEmail, "new@hyundai.com");
    assert.equal(savedPlan.hyundaiManagerName, "새 관리자");
    assert.equal(savedPlan.status, "approved");
    assert.equal(savedPlan.workLocation, "기존 작업내용");
    assert.deepEqual(savedPlan.approval, approval);

    const indexPut = calls.find(({ method, url }) => method === "PUT" && decodeURIComponent(url.pathname).endsWith("/data/index.json"));
    const indexPayload = JSON.parse(indexPut.body);
    const savedIndex = JSON.parse(Buffer.from(indexPayload.content, "base64").toString());
    assert.equal(savedIndex[0].hyundaiManagerName, "새 관리자");
    assert.equal(savedIndex[0].status, "approved");
  });
});

test("Hyundai can assign the resident manager while parallel approval is in progress", async () => {
  const files = {
    "data/plans/approving-plan.json": { id: "approving-plan", company: "협력사", status: "approving" },
    "data/index.json": [{ id: "approving-plan", status: "approving" }],
  };
  await withMockFetch({ email: "hyundai@example.com", files }, async (calls) => {
    const response = await request("/api/plans/approving-plan/hyundai-manager", {
      method: "POST",
      body: { hyundaiManagerEmail: "", hyundaiManagerName: "진행중 관리자" },
    });
    assert.equal(response.status, 200);
    const planPut = calls.find(({ method, url }) => method === "PUT" && decodeURIComponent(url.pathname).endsWith("/data/plans/approving-plan.json"));
    const saved = JSON.parse(Buffer.from(JSON.parse(planPut.body).content, "base64").toString());
    assert.equal(saved.status, "approving");
    assert.equal(saved.hyundaiManagerName, "진행중 관리자");
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

test("approved plans cannot be deleted by vendor or non-ADMIN Hyundai", async () => {
  const files = {
    "data/plans/approved-plan.json": {
      id: "approved-plan",
      company: "협력사",
      status: "approved",
      writerEmail: "vendor@example.com",
    },
  };
  for (const email of ["vendor@example.com", "hyundai@example.com"]) {
    await withMockFetch({ email, files }, async (calls) => {
      const response = await request("/api/plans/approved-plan", { method: "DELETE" });
      assert.equal(response.status, 400, email);
      assert.equal(calls.some(({ method }) => method === "DELETE"), false, email);
    });
  }
});


test("plan deletion enforces role and status permissions and preserves other index entries", async () => {
  for (const status of ["draft", "pending", "approving", "approved", "rejected", "unknown"]) {
    for (const email of ["vendor@example.com", "other@example.com", "hyundai@example.com", "admin@example.com"]) {
      const plan = { id: "target-plan", company: "협력사", status, writerEmail: "vendor@example.com" };
      const other = { id: "other-plan", status: "approved", company: "다른협력사" };
      const files = { "data/plans/target-plan.json": plan, "data/index.json": [plan, other] };
      await withMockFetch({ email, files }, async (calls) => {
        const allowed = status === "draft" ? email !== "other@example.com"
          : ["pending", "approving"].includes(status) ? ["hyundai@example.com", "admin@example.com"].includes(email)
            : ["approved", "rejected"].includes(status) && email === "admin@example.com";
        const response = await request("/api/plans/target-plan", { method: "DELETE" });
        const label = `${email}: ${status}`;
        if (!allowed) {
          assert.ok([400, 403].includes(response.status), label);
          assert.equal(calls.some(({ method }) => method === "DELETE" || method === "PUT"), false, label);
          return;
        }
        assert.equal(response.status, 200, label);
        assert.deepEqual(await response.json(), { ok: true });
        const deletes = calls.filter(({ method }) => method === "DELETE");
        assert.equal(deletes.length, 1, label);
        assert.ok(decodeURIComponent(deletes[0].url.pathname).endsWith("/data/plans/target-plan.json"));
        const deleted = JSON.parse(deletes[0].body);
        assert.equal(deleted.sha, "data/plans/target-plan.json-sha");
        assert.ok(deleted.message.includes(`actor=${email}`));
        const puts = calls.filter(({ method }) => method === "PUT");
        assert.equal(puts.length, 1);
        assert.ok(decodeURIComponent(puts[0].url.pathname).endsWith("/data/index.json"));
        const saved = JSON.parse(Buffer.from(JSON.parse(puts[0].body).content, "base64").toString());
        assert.deepEqual(saved, [other]);
      });
    }
  }
});
