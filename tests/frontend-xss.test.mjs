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
    document: { querySelectorAll() { return []; } },
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
      const element = { innerHTML: "", className: "", querySelector: () => null };
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

function response(data, ok = true) { return { ok, json: async () => data }; }
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("directory cache shares requests, expires, and isolates login tokens", async () => {
  let now = 0;
  let calls = 0;
  const pending = deferred();
  const context = makeContext(async () => { calls++; return calls === 1 ? pending.promise : response({ managers: [] }); }, {
    Date: class extends Date { static now() { return now; } },
  });
  vm.runInContext('state.idToken = "account-a"', context);
  const first = context.api("/api/managers?org=hyundai");
  const second = context.api("/api/managers?org=hyundai");
  assert.equal(calls, 1);
  pending.resolve(response({ managers: [] }));
  await Promise.all([first, second]);
  await context.api("/api/managers?org=hyundai");
  assert.equal(calls, 1);
  now = 30001;
  await context.api("/api/managers?org=hyundai");
  assert.equal(calls, 2);
  vm.runInContext('state.idToken = "account-b"', context);
  await context.api("/api/managers?org=hyundai");
  assert.equal(calls, 3);
});

test("writes invalidate directories and in-flight reads cannot repopulate stale cache", async () => {
  const pending = deferred();
  let reads = 0;
  const context = makeContext(async (_url, init) => {
    if (init.method === "POST") return response({ ok: true });
    reads++;
    return reads === 1 ? pending.promise : response({ companies: ["updated"] });
  });
  const stale = context.api("/api/companies", { auth: false });
  await context.api("/api/admin/rename-company", { method: "POST", body: {} });
  pending.resolve(response({ companies: ["old"] }));
  await stale;
  const fresh = await context.api("/api/companies", { auth: false });
  assert.equal(fresh.companies[0], "updated");
  assert.equal(reads, 2);
});

test("failed directory requests retry and plans are always fetched fresh", async () => {
  let calls = 0;
  const context = makeContext(async () => { calls++; return response(calls === 1 ? { error: "failed" } : {}, calls !== 1); });
  await assert.rejects(context.api("/api/companies"), /failed/);
  await context.api("/api/companies");
  await context.api("/api/plans");
  await context.api("/api/plans");
  assert.equal(calls, 4);
});

test("new vendor form starts independent requests together and skips company lookup", async () => {
  const calls = [];
  const plans = deferred(), managers = deferred();
  const elements = Object.fromEntries(["f_company", "f_workDate", "f_workDateLabel", "f_workType", "f_vendorManager", "f_vendorManagerManual", "f_startHour", "f_startMin", "f_endHour", "f_endMin"].map((id) => [id, {
    value: id === "f_workType" ? "점심" : id === "f_workDate" ? "2026-10-11" : "", addEventListener() {},
    classList: { add() {}, toggle() {} },
  }]));
  const context = makeContext(async (url) => {
    calls.push(url);
    if (url.endsWith("/api/plans")) return plans.promise;
    if (url.includes("/api/managers?")) return managers.promise;
    assert.fail(`Unexpected request: ${url}`);
  }, { document: { getElementById: (id) => elements[id] } });
  context.__setStateUser({ company: "협력사", org: "vendor" });
  const container = { innerHTML: "", querySelector: () => null };
  const loading = context.loadForm(container);
  await new Promise(setImmediate);
  assert.equal(calls.length, 2);
  assert.equal(calls.some((url) => url.includes("/companies")), false);
  plans.resolve(response({ plans: [] }));
  managers.resolve(response({ managers: [] }));
  await loading;
  assert.match(container.innerHTML, /작업계획서 작성/);
  assert.equal(elements.f_startHour.value, "11");
  assert.equal(elements.f_endHour.value, "13");
});

test("PDF libraries load on demand, share loads, and recover from errors", async () => {
  assert.doesNotMatch(html, /<script src="https:\/\/cdnjs[^\"]*(?:jspdf|jszip)/);
  const scripts = [];
  const context = makeContext(undefined, { document: {
    createElement: () => ({ remove() {} }), head: { appendChild: (script) => scripts.push(script) },
  } });
  const first = context.loadExportLibrary("jspdf");
  const second = context.loadExportLibrary("jspdf");
  assert.equal(first, second);
  assert.equal(scripts.length, 1);
  scripts[0].onerror();
  await assert.rejects(first, /PDF 라이브러리/);
  const retry = context.loadExportLibrary("jspdf");
  assert.equal(scripts.length, 2);
  context.window.jspdf = { jsPDF() {} };
  scripts[1].onload();
  await retry;
  await context.loadExportLibrary("jspdf");
  assert.equal(scripts.length, 2);
});

test("PDF library timeout permits a new attempt", async () => {
  const scripts = [], timers = new Map();
  let id = 0;
  const context = makeContext(undefined, {
    setTimeout: (callback) => { timers.set(++id, callback); return id; }, clearTimeout: (key) => timers.delete(key),
    document: { createElement: () => ({ remove() {} }), head: { appendChild: (script) => scripts.push(script) } },
  });
  const loading = context.loadExportLibrary("jszip");
  timers.get(1)();
  await assert.rejects(loading, /초과/);
  const retry = context.loadExportLibrary("jszip");
  context.window.JSZip = function () {};
  scripts[1].onload();
  await retry;
  assert.equal(scripts.length, 2);
});

test("performance measurements omit tokens and plan IDs", async () => {
  const names = [];
  const context = makeContext(async () => response({ plan: {} }), { performance: {
    now: () => 100, clearMeasures() {}, measure: (name) => names.push(name),
  } });
  vm.runInContext('state.idToken = "secret-token"', context);
  await context.api("/api/plans/private-plan-id");
  assert.deepEqual(names, ["overtime:api:GET:/api/plans/:id"]);
});


test("detail deletion matches ADMIN and existing role permissions", async () => {
  for (const status of ["draft", "pending", "approving", "approved", "rejected", "unknown"]) {
    for (const role of ["writer", "vendor", "hyundai", "admin"]) {
      const plan = { id: "plan-1", company: "협력사", status, writerEmail: "writer@example.com", workDate: "2026-10-11", workType: "점심" };
      const context = makeContext(async (url) => ({
        ok: true, json: async () => url.includes("/api/managers") ? { managers: [] } : { plan },
      }));
      context.__setStateUser({ email: `${role}@example.com`, company: "협력사", org: ["hyundai", "admin"].includes(role) ? "hyundai" : "vendor", isAdmin: role === "admin" });
      const container = { innerHTML: "", querySelector: () => null };
      await context.loadDetail(container, plan.id);
      const allowed = status === "draft" ? role !== "vendor"
        : ["pending", "approving"].includes(status) ? ["hyundai", "admin"].includes(role)
          : ["approved", "rejected"].includes(status) && role === "admin";
      assert.equal(container.innerHTML.includes('id="detailDeleteButton"'), allowed, `${role}: ${status}`);
    }
  }
});


test("vendor test mode sends the role header and isolates directory cache", async () => {
  const calls = [];
  const context = makeContext(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ managers: [] }) };
  });
  vm.runInContext('state.idToken = "admin-token"', context);
  await context.api("/api/managers?org=vendor");
  vm.runInContext('state.vendorTestMode = true', context);
  await context.api("/api/managers?org=vendor");
  await context.api("/api/auth", { method: "POST", body: { idToken: "admin-token" }, auth: false });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.headers["X-OverTime-Test-Mode"], undefined);
  assert.equal(calls[1].options.headers["X-OverTime-Test-Mode"], "vendor");
  assert.equal(calls[2].options.headers["X-OverTime-Test-Mode"], "vendor");
  assert.equal(calls[1].options.headers.Authorization, "Bearer admin-token");
});

test("mode switching accepts server roles and rolls back if an old Worker ignores the header", async () => {
  let supported = false;
  const messages = [];
  const context = makeContext(async (url, options) => ({ ok: true, json: async () => ({ status: "approved", user: supported && options.headers["X-OverTime-Test-Mode"] ? { org: "vendor", isAdmin: false, vendorTestMode: true } : { org: "hyundai", isAdmin: true } }) }), { alert: message => messages.push(message) });
  vm.runInContext('state.user = { org: "hyundai", isAdmin: true }; state.idToken = "token"; go = () => {}; refreshSignupCount = () => {};', context);
  await context.switchVendorTestMode(true);
  assert.equal(vm.runInContext('state.vendorTestMode', context), false);
  assert.equal(vm.runInContext('state.user.isAdmin', context), true);
  assert.match(messages[0], /최신 Worker/);
  supported = true;
  await context.switchVendorTestMode(true);
  assert.equal(vm.runInContext('state.user.org', context), "vendor");
  assert.equal(context.canManageSignups(), false);
  await context.switchVendorTestMode(false);
  assert.equal(vm.runInContext('state.user.isAdmin', context), true);
  assert.equal(vm.runInContext('state.vendorTestMode', context), false);
});

test("vendor test controls are ADMIN-only and the return banner remains visible", () => {
  const created = [];
  const document = {
    body: { classList: { toggle() {} } },
    createElement() {
      const element = { innerHTML: "", appendChild() {}, querySelector(selector) {
        return this.innerHTML.includes(`id="${selector.slice(1)}"`) ? { addEventListener() {} } : null;
      } };
      created.push(element);
      return element;
    },
    getElementById() { return { innerHTML: "", appendChild() {} }; },
  };
  const context = makeContext(undefined, { document, setTimeout() {} });
  context.__setStateUser({ name: "Admin", company: "현대건설", org: "hyundai", isAdmin: true });
  assert.match(context.renderMyPage().innerHTML, /id="enterVendorTestMode"/);
  context.__setStateUser({ name: "Admin", company: "[테스트] 협력업체", org: "vendor", isAdmin: false, vendorTestMode: true });
  assert.doesNotMatch(context.renderMyPage().innerHTML, /id="enterVendorTestMode"|가입 승인 관리|사용자 관리/);
  vm.runInContext('renderRoute = () => document.createElement("div")', context);
  context.render();
  assert.ok(created.some(element => element.innerHTML.includes('id="exitVendorTestMode"')));
});

test("safety-first approval keeps the execution button available after ADMIN restoration", async () => {
  const plan = { id: "test-plan", company: "[테스트] 협력업체", status: "pending", workDate: "2026-10-11", safetyApproval: { approverName: "Admin", approvedAt: "2026-10-11T01:00:00Z" } };
  const context = makeContext(async url => ({ ok: true, json: async () => url.includes("/api/managers") ? { managers: [] } : { plan } }));
  context.__setStateUser({ org: "hyundai", isAdmin: true });
  const container = { innerHTML: "", querySelector: () => null };
  await context.loadDetail(container, plan.id);
  assert.match(container.innerHTML, /id="detailExecutionReviewButton"/);
  assert.doesNotMatch(container.innerHTML, /id="detailSafetyApproveButton"/);
  assert.match(container.innerHTML, /badge pending">검토중/);
});
