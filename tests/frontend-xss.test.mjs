import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const scriptStart = html.lastIndexOf("<script>") + "<script>".length;
const scriptEnd = html.indexOf("</script>", scriptStart);
const script = html.slice(scriptStart, scriptEnd).replace(
  /bootAuth\(\);\s*$/,
  "globalThis.__setStateUser = (user) => { state.user = user; };"
);

function makeContext(fetchImpl = async () => { throw new Error("unexpected fetch"); }, extra = {}) {
  const context = {
    URLSearchParams,
    clearTimeout,
    console,
    fetch: fetchImpl,
    setTimeout,
    window: { addEventListener() {} },
    ...extra,
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  return context;
}

const attack = `<img src=x onerror="globalThis.xss=1">'`;

test("home plan cards escape data and do not build inline handlers", () => {
  const context = makeContext();
  const card = context.planCardHtml({
    id: attack,
    workDate: "2026-10-02",
    workTimeStart: attack,
    workTimeEnd: attack,
    workType: attack,
    status: attack,
    company: attack,
    writerName: attack,
    approverName: attack,
    vendorManagerName: attack,
    hyundaiManagerName: attack,
  });

  assert.doesNotMatch(card, /<img/i);
  assert.doesNotMatch(card, /onclick=/i);
  assert.match(card, /&lt;img/);
  assert.doesNotMatch(card, /상주관리자 협력업체/);
  assert.equal(context.planStatusClass(attack), "");
});

test("home plan cards use review and approval wording", () => {
  const context = makeContext();
  const basePlan = {
    id: "plan-1",
    workDate: "2026-10-24",
    workType: "야간",
    status: "pending",
    company: "테스트 업체",
    writerName: "작성자",
  };

  const pendingCard = context.planCardHtml(basePlan);
  assert.match(pendingCard, /검토중 · 승인중/);
  assert.doesNotMatch(pendingCard, /수행팀 대기중|안전팀 대기중/);

  const approvedCard = context.planCardHtml({
    ...basePlan,
    status: "approved",
    executionReviewerName: "검토자",
    safetyApproverName: "승인자",
  });
  assert.match(approvedCard, /검토 검토자 · 승인 승인자/);
  assert.doesNotMatch(approvedCard, /수행팀 검토자|안전팀 승인자/);
});

test("company filter options escape values and labels", () => {
  const context = makeContext();
  context.__setStateUser({ org: "vendor", isAdmin: false });
  const options = context.planViewFilterOptionsHtml([attack]);

  assert.doesNotMatch(options, /<img/i);
  assert.match(options, /&lt;img/);
});

test("detail view escapes plan fields and uses bound actions", async () => {
  const plan = {
    id: attack,
    status: "draft",
    company: attack,
    workDate: "2026-10-02",
    workTimeStart: "06:00",
    workTimeEnd: "07:00",
    workType: attack,
    writerEmail: "writer@example.com",
    writerName: attack,
    rejectReason: attack,
    workLocation: attack,
    workforceEquipment: attack,
    hazards: attack,
    mitigations: attack,
    vendorManagerName: attack,
    hyundaiManagerName: attack,
  };
  const context = makeContext(async () => ({ ok: true, json: async () => ({ plan }) }));
  context.__setStateUser({ email: "writer@example.com", company: attack, org: "vendor", isAdmin: false });
  const container = { innerHTML: "", querySelector: () => null };

  await context.loadDetail(container, plan.id);

  assert.doesNotMatch(container.innerHTML, /<img/i);
  assert.doesNotMatch(container.innerHTML, /onclick=/i);
  assert.match(container.innerHTML, /&lt;img/);
  assert.equal((container.innerHTML.match(/class="detail-field-title"/g) || []).length, 5);
});

test("pending detail uses in-progress labels and paired approval actions", async () => {
  const plan = {
    id: "plan-1",
    status: "pending",
    company: "테스트 업체",
    workDate: "2026-10-18",
    workTimeStart: "11:30",
    workTimeEnd: "13:00",
    workType: "점심",
    writerEmail: "writer@example.com",
    writerName: "작성자",
  };
  const context = makeContext(async (url) => ({
    ok: true,
    json: async () => url.includes("/api/managers") ? { managers: [] } : { plan },
  }));
  context.__setStateUser({ email: "reviewer@example.com", company: "현대건설", org: "hyundai", isAdmin: false });
  const container = { innerHTML: "", querySelector: () => null };

  await context.loadDetail(container, plan.id);

  assert.match(container.innerHTML, /수행팀[\s\S]*검토중/);
  assert.match(container.innerHTML, /안전팀[\s\S]*승인중/);
  assert.doesNotMatch(container.innerHTML, /미검토|미승인|대기중/);
  assert.match(container.innerHTML, /수행팀 결재[\s\S]*안전팀 결재[\s\S]*수행팀 반려[\s\S]*안전팀 반려/);
  assert.doesNotMatch(container.innerHTML, /detail(?:Execution|Safety)RejectButton" class="block"/);
  assert.match(container.innerHTML, /2026\.10\.18\(일\)[\s\S]*11:30~13:00 · [\s\S]*점심/);
});

test("each approval action sends the selected Hyundai resident manager", async () => {
  const requests = [];
  const select = {
    value: "manager@hyundai.com",
    selectedIndex: 1,
    options: [{ text: "선택" }, { text: "현대 현장소장" }],
  };
  const context = makeContext(async (url, init) => {
    requests.push({ url, init });
    return { ok: true, json: async () => ({ ok: true }) };
  }, {
    alert() {},
    confirm: () => true,
    document: { getElementById: (id) => id === "approveManager" ? select : null },
  });

  await context.completeApprovalStep("plan-1", "execution");
  await context.completeApprovalStep("plan-1", "safety");

  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /\/api\/plans\/plan-1\/execution-review$/);
  assert.match(requests[1].url, /\/api\/plans\/plan-1\/safety-approve$/);
  for (const request of requests) {
    assert.deepEqual(JSON.parse(request.init.body), {
      hyundaiManagerEmail: "manager@hyundai.com",
      hyundaiManagerName: "현대 현장소장",
    });
  }
});

test("edit form escapes stored plan and manager values", async () => {
  const formAttack = `</textarea><img src=x onerror="globalThis.xss=1">'`;
  const plan = {
    id: formAttack,
    workDate: "2026-10-02",
    workType: "점심",
    company: formAttack,
    workLocation: formAttack,
    workforceEquipment: formAttack,
    hazards: formAttack,
    mitigations: formAttack,
    workTimeStart: "11:30",
    workTimeEnd: "13:00",
    vendorManagerEmail: formAttack,
  };
  const elements = {
    f_company: { value: formAttack, addEventListener() {} },
    f_workDate: { value: plan.workDate, addEventListener() {} },
    f_workDateLabel: { textContent: "" },
    f_workType: { value: plan.workType, addEventListener() {} },
    f_vendorManager: { value: formAttack, addEventListener() {} },
    f_vendorManagerManual: {
      value: "",
      classList: { add() {}, toggle() {} },
      focus() {},
    },
  };
  const document = { getElementById: (id) => elements[id] };
  const fetchImpl = async (url) => {
    if (url.includes("/api/plans/")) return { ok: true, json: async () => ({ plan }) };
    if (url.includes("/api/companies")) return { ok: true, json: async () => ({ companies: [formAttack] }) };
    if (url.includes("/api/managers")) {
      return { ok: true, json: async () => ({ managers: [{ email: formAttack, name: formAttack }] }) };
    }
    if (url.includes("/api/plans")) return { ok: true, json: async () => ({ plans: [] }) };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const context = makeContext(fetchImpl, { document });
  context.__setStateUser({ email: "writer@example.com", company: formAttack, org: "vendor", isAdmin: false });
  const container = { innerHTML: "", querySelector: () => null };

  await context.loadForm(container, plan.id);

  assert.doesNotMatch(container.innerHTML, /<img/i);
  assert.doesNotMatch(container.innerHTML, /onclick="savePlanForm/i);
  assert.match(container.innerHTML, /&lt;\/textarea&gt;&lt;img/);
  assert.match(container.innerHTML, />직접입력<\/option>/);
  assert.match(container.innerHTML, /<textarea id="f_workforceEquipment" rows="2"/);
  assert.match(container.innerHTML, /8명\(관리자 4, 유도원 3, 06W 1대\).*OOO 소장, OOO 과장, OOO 대리, OOO 사원/);
});

test("download template escapes resident manager and approval identities", () => {
  const context = makeContext();
  const rendered = context.planToTemplateHtml({
    company: attack,
    workDate: "2026-10-03",
    workType: attack,
    workLocation: attack,
    workforceEquipment: attack,
    hazards: attack,
    mitigations: attack,
    vendorManagerName: attack,
    hyundaiManagerName: attack,
    writerEmail: "writer@example.com",
    writerName: attack,
    approval: { approverName: attack, approvedAt: "2026-10-03T01:00:00.000Z" },
  });

  assert.doesNotMatch(rendered, /<img/i);
  assert.match(rendered, /&lt;img/);
  assert.match(rendered, /<th>담당자<\/th>/);
  assert.ok(rendered.indexOf(">협력업체<") < rendered.indexOf(">현대건설<"));
  assert.match(rendered, /data-signature-key="vendor" data-signature/);
});

test("printable plan uses equal page margins and a safe work-date filename", () => {
  const context = makeContext();
  const plan = {
    company: "협력/업체",
    workDate: "2026-10-03",
    workType: "야간:작업",
  };

  assert.equal(context.safePdfFileBase(plan), "2026-10-03_야간_작업_협력_업체");
  const rendered = context.printablePlanDocument(plan);
  assert.match(rendered, /<title>2026-10-03_야간_작업_협력_업체<\/title>/);
  assert.match(rendered, /@page \{ size:A4 portrait; margin:10mm; \}/);
  assert.match(rendered, /print-color-adjust:exact !important/);
  assert.doesNotMatch(rendered, /html2canvas/);
});

test("identity and registration views escape user and company values", () => {
  const created = [];
  const document = {
    createElement() {
      const element = { innerHTML: "", className: "" };
      created.push(element);
      return element;
    },
  };
  const context = makeContext(undefined, { document, setTimeout() {} });
  context.__setStateUser({ name: attack, company: attack, org: "vendor", isAdmin: false, signatureUrl: null });

  const header = context.renderHeader();
  const myPage = context.renderMyPage();
  const companyOptions = context.registrationCompanyOptionsHtml([attack]);

  for (const rendered of [header.innerHTML, myPage.innerHTML, companyOptions]) {
    assert.doesNotMatch(rendered, /<img/i);
    assert.match(rendered, /&lt;img/);
  }
});

test("pending-user approval view does not embed emails in inline handlers", async () => {
  const pendingUser = { email: attack, name: attack, company: attack, phone: attack };
  const context = makeContext(async () => ({ ok: true, json: async () => ({ pending: [pendingUser] }) }));
  const container = { innerHTML: "", querySelectorAll: () => [] };

  await context.loadAdmin(container);

  assert.doesNotMatch(container.innerHTML, /<img/i);
  assert.doesNotMatch(container.innerHTML, /onclick="approveUser/i);
  assert.match(container.innerHTML, /&lt;img/);
});

test("ADMIN user rows whitelist status classes and avoid inline actions", () => {
  const context = makeContext();
  const row = context.userRowHtml({
    name: attack,
    company: attack,
    phone: attack,
    email: attack,
    status: attack,
    isAdmin: false,
  }, 0);

  assert.doesNotMatch(row, /<img/i);
  assert.doesNotMatch(row, /onclick=/i);
  assert.match(row, /data-user-action="edit"/);
  assert.match(row, /class="badge "/);
  assert.equal(context.userStatusClass(attack), "");
});

test("batch month limits include leap years, month ends and invalid dates", () => {
  const context = makeContext();
  for (const [from, max] of [
    ["2026-10-06", "2026-11-05"], ["2026-01-01", "2026-01-31"],
    ["2026-01-31", "2026-02-27"], ["2024-01-31", "2024-02-28"],
    ["2026-12-15", "2027-01-14"], ["2026-02-01", "2026-02-28"],
  ]) assert.equal(context.batchDateMax(from), max);
  for (const value of ["", "2026-02-30", "2026-13-01", "bad"]) {
    assert.equal(context.batchDateMax(value), "");
  }
});

test("batch rejects reversed or excessive periods before making API requests", async () => {
  for (const [from, to] of [["2026-10-06", "2026-11-06"], ["2026-10-06", "2026-10-05"], ["2026-02-30", "2026-03-01"]]) {
    const alerts = [];
    const context = makeContext(async () => { assert.fail("invalid period must not fetch"); }, {
      document: { getElementById: (id) => ({ value: id === "batchFrom" ? from : to }) },
      alert: (message) => alerts.push(message),
    });
    await context.batchDownload();
    assert.equal(alerts.length, 1);
  }
});

test("batch manager cache reuses directory requests for multiple plans", async () => {
  const calls = [];
  const context = makeContext(async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ managers: [{ email: "manager@example.com", phone: "010-1234-5678" }] }) };
  });
  const plan = { company: "협력업체", vendorManagerEmail: "manager@example.com", hyundaiManagerEmail: "manager@example.com" };
  const cache = new Map();
  const first = await context.withManagerContacts(plan, cache);
  const second = await context.withManagerContacts(plan, cache);
  assert.equal(calls.length, 2);
  assert.equal(first.vendorManagerPhone, "010-1234-5678");
  assert.equal(second.hyundaiManagerPhone, "010-1234-5678");
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

test("company choices share concurrent requests, expire after 60 seconds and retry failures", async () => {
  const requests = [];
  const context = makeContext(() => {
    const request = deferred();
    requests.push(request);
    return request.promise;
  });
  vm.runInContext("globalThis.__now = 0; Date.now = () => globalThis.__now;", context);
  const first = context.loadCompanies();
  const second = context.loadCompanies();
  assert.equal(requests.length, 1);
  requests[0].resolve({ ok: true, json: async () => ({ companies: ["A"] }) });
  assert.equal((await first).companies[0], "A");
  await second;
  context.__now = 59999;
  await context.loadCompanies();
  assert.equal(requests.length, 1);
  context.__now = 60000;
  const expired = context.loadCompanies();
  requests[1].reject(new Error("offline"));
  await assert.rejects(expired, /offline/);
  const retry = context.loadCompanies();
  assert.equal(requests.length, 3);
  requests[2].resolve({ ok: true, json: async () => ({ companies: ["B"] }) });
  assert.equal((await retry).companies[0], "B");
});

function formDocument() {
  const elements = new Map();
  return { getElementById(id) {
    if (!elements.has(id)) elements.set(id, {
      value: id === "f_workDate" ? "2026-10-10" : "", addEventListener() {},
      classList: { add() {}, toggle() {} },
    });
    return elements.get(id);
  } };
}

test("new vendor form starts summary and manager reads together without company fetch", async () => {
  const requests = new Map();
  const context = makeContext((url) => {
    const request = deferred();
    requests.set(new URL(url).pathname, request);
    return request.promise;
  }, { document: formDocument() });
  context.__setStateUser({ org: "vendor", company: "A" });
  const container = { innerHTML: "", querySelector: () => null };
  const loading = context.loadForm(container);
  await flushPromises();
  assert.deepEqual([...requests.keys()].sort(), ["/api/managers", "/api/plans"]);
  // Optional reads still allow the form to render when they fail.
  for (const request of requests.values()) request.reject(new Error("offline"));
  await loading;
  assert.match(container.innerHTML, /작업계획서 작성/);
  assert.match(container.innerHTML, /<option value="A" selected>A<\/option>/);
});

test("edit form starts independent reads before detail and waits for its company for managers", async () => {
  const requests = new Map();
  const context = makeContext((url) => {
    const request = deferred();
    requests.set(url.split("/api/")[1], request);
    return request.promise;
  }, { document: formDocument() });
  context.__setStateUser({ org: "hyundai", company: "현대건설" });
  const container = { innerHTML: "", querySelector: () => null };
  const loading = context.loadForm(container, "p1");
  assert.deepEqual([...requests.keys()].sort(), ["companies", "plans", "plans/p1"]);
  requests.get("plans/p1").resolve({ ok: true, json: async () => ({ plan: { company: "A", workDate: "2026-10-10" } }) });
  await flushPromises();
  assert.ok(requests.has("managers?org=vendor&company=A"));
  requests.get("companies").resolve({ ok: true, json: async () => ({ companies: ["A"] }) });
  requests.get("plans").resolve({ ok: true, json: async () => ({ plans: [] }) });
  requests.get("managers?org=vendor&company=A").resolve({ ok: true, json: async () => ({ managers: [] }) });
  await loading;
  assert.match(container.innerHTML, /작업계획서 수정/);
});

test("failed edit detail renders an error without fetching managers", async () => {
  const calls = [];
  const context = makeContext(async (url) => {
    calls.push(url);
    if (url.includes("/api/plans/")) throw new Error("detail unavailable");
    return { ok: true, json: async () => ({ plans: [] }) };
  });
  context.__setStateUser({ org: "vendor", company: "A" });
  const container = { innerHTML: "" };
  await context.loadForm(container, "p1");
  assert.match(container.innerHTML, /detail unavailable/);
  assert.equal(calls.some((url) => url.includes("/api/managers")), false);
});

test("export libraries are lazy, deduplicate loads and retry a failed script", async () => {
  assert.doesNotMatch(html, /<script[^>]+src="[^"]*(?:jspdf|jszip)/i);
  const scripts = [];
  const context = makeContext(undefined, { document: {
    createElement: () => ({ remove() { this.removed = true; } }),
    head: { appendChild: (script) => scripts.push(script) },
  } });
  assert.equal(scripts.length, 0);
  const first = context.loadExportLibrary("jspdf");
  const second = context.loadExportLibrary("jspdf");
  assert.equal(scripts.length, 1);
  context.window.jspdf = { jsPDF() {} };
  scripts[0].onload();
  await Promise.all([first, second]);
  await context.loadExportLibrary("jspdf");
  assert.equal(scripts.length, 1);
  const failed = context.loadExportLibrary("jszip");
  scripts[1].onerror();
  await assert.rejects(failed, /다시 시도/);
  assert.equal(scripts[1].removed, true);
  const retry = context.loadExportLibrary("jszip");
  assert.equal(scripts.length, 3);
  context.window.JSZip = function JSZip() {};
  scripts[2].onload();
  await retry;
});
