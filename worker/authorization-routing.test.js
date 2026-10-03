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
  "vendor@example.com": { name: "Vendor", company: "협력사", org: "vendor", phone: "010-1234-5678", status: "approved" },
  "other@example.com": { name: "Other", company: "다른협력사", org: "vendor", status: "approved" },
  "hyundai@example.com": { name: "Hyundai", company: "현대건설(주)", org: "hyundai", status: "approved", signatureUrl: "signatures/hyundai.png" },
  "admin@example.com": { name: "Admin", company: "협력사", org: "vendor", status: "approved", signatureUrl: "signatures/admin.png" },
};

test("manager lookup includes the registered phone number", async () => {
  await withMockFetch({}, async () => {
    const response = await request("/api/managers?org=vendor&company=" + encodeURIComponent("협력사"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      managers: [{ email: "vendor@example.com", name: "Vendor", company: "협력사", phone: "010-1234-5678" }],
    });
  });
});

function githubContent(value, sha = "sha") {
  return { sha, content: Buffer.from(JSON.stringify(value)).toString("base64") };
}

function mockExternalRequests({ email = "vendor@example.com", users = approvedUsers, files = {} } = {}) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init.method || (typeof input === "string" ? "GET" : input.method) || "GET";
    calls.push({ url, method, body: init.body });

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
