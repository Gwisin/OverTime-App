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
    writerName: attack,
    approval: { approverName: attack, approvedAt: "2026-10-03T01:00:00.000Z" },
  });

  assert.doesNotMatch(rendered, /<img/i);
  assert.match(rendered, /&lt;img/);
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
