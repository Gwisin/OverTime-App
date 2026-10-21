import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const script = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>")).replace(/bootAuth\(\);\s*$/, "");
function browser() {
  let now = Date.parse("2026-10-21T14:00:00Z");
  const storage = new Map();
  const timers = new Map();
  const listeners = {};
  const app = { innerHTML: "", querySelector: () => ({ addEventListener() {} }) };
  let timerId = 0;
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } }, console,
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    window: { addEventListener: (name, fn) => { listeners[name] = fn; } },
    document: { getElementById: () => app, addEventListener: (name, fn) => { listeners[name] = fn; }, visibilityState: "visible" },
  });
  vm.runInContext(script, context);
  vm.runInContext('go = () => {}; render = () => {}; refreshSignupCount = () => {};', context);
  return { context, storage, timers, listeners, app, jump: (time) => { now = time; } };
}
const expires = Date.parse("2026-10-21T15:00:00Z");
const data = { sessionToken: "ot1.payload.signature", sessionExpiresAt: expires };

test("reload restores app session without requesting a renewed session", async () => {
  const b = browser();
  b.context.saveSession(data);
  const saved = b.storage.get("overtimeSession");
  const reopened = browser();
  reopened.storage.set("overtimeSession", saved);
  let body;
  reopened.context.api = async (path, options) => { body = options.body; return { status: "approved", user: { email: "user@example.com" } }; };
  await reopened.context.bootAuth();
  assert.equal(body.idToken, data.sessionToken);
  assert.equal(body.issueSession, undefined);
  assert.equal(reopened.storage.get("overtimeSession"), saved);
  assert.equal(vm.runInContext("state.sessionExpiresAt", reopened.context), expires);
});

test("network and server failures retain saved session; 401 clears it", async () => {
  for (const status of [undefined, 500, 503, 401]) {
    const b = browser(); b.context.saveSession(data);
    b.context.api = async () => { throw Object.assign(new Error("failed"), { status }); };
    await b.context.bootAuth();
    assert.equal(b.storage.has("overtimeSession"), status !== 401);
    if (status !== 401) assert.match(b.app.innerHTML, /다시 시도/);
  }
});

test("midnight timer, Safari wake and API calls clear expired sessions", async () => {
  for (const trigger of ["timer", "pageshow", "visibilitychange", "api", "boot"]) {
    const b = browser(); b.context.saveSession(data);
    const timer = [...b.timers.values()].at(-1);
    assert.equal(timer.delay, 3600000);
    b.jump(expires);
    if (trigger === "timer") timer.callback();
    else if (trigger === "api") await assert.rejects(b.context.api("/api/plans"), /자정/);
    else if (trigger === "boot") await b.context.bootAuth();
    else b.listeners[trigger]();
    assert.equal(b.storage.has("overtimeSession"), false, trigger);
    assert.equal(vm.runInContext("state.idToken", b.context), null, trigger);
  }
});

test("logout propagates to another tab and never silently signs back in", () => {
  const b = browser(); b.context.saveSession(data);
  b.listeners.storage({ key: "overtimeSession", newValue: null });
  assert.equal(b.storage.has("overtimeSession"), false);
  assert.equal(b.timers.size, 0);
});

test("a request completing after midnight cannot return protected data after timer logout", async () => {
  const b = browser(); b.context.saveSession(data);
  let finish;
  b.context.fetch = () => new Promise((resolve) => { finish = resolve; });
  const pending = b.context.api("/api/plans");
  b.jump(expires);
  [...b.timers.values()].at(-1).callback();
  finish({ ok: true, json: async () => ({ plans: ["private"] }) });
  await assert.rejects(pending, /자정/);
  assert.equal(b.storage.has("overtimeSession"), false);
});
