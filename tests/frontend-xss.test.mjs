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

function makeContext(fetchImpl = async () => { throw new Error("unexpected fetch"); }) {
  const context = {
    URLSearchParams,
    clearTimeout,
    console,
    fetch: fetchImpl,
    setTimeout,
    window: { addEventListener() {} },
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
});
