import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = (file) => readFileSync(new URL("../" + file, import.meta.url), "utf8");
const sdkSource = source("src-tauri/src/plugins/a2.js");
const frameSource = source("public/src/js/pluginFrame.js");
const widgetSource = source("public/src/js/pluginWidget.js");
const settingsSource = source("public/src/js/pluginSettings.js");
const origin = "https://api.example.com";
const plain = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function sdk() {
  const sent = [], listeners = new Map();
  const parent = { postMessage: (message) => sent.push(plain(message)) };
  const window = { parent, addEventListener: (name, fn) => listeners.set(name, fn) };
  const root = { style: { setProperty() {} }, prepend() {} };
  vm.runInNewContext(sdkSource, {
    window, document: { documentElement: root, head: root, createElement: () => ({}), addEventListener() {} },
    URLSearchParams, location: { search: "" }, console,
  });
  return {
    a2: window.a2, sent,
    answer: (result, error) => listeners.get("message")({ source: parent, data: { a2: 1, id: sent.at(-1).id, result, error } }),
  };
}

async function host({ permissions = ["network:" + origin], docked = false, provider, widget = false } = {}) {
  const sent = [], invoked = [], listeners = new Map();
  const frame = { contentWindow: { postMessage: (message) => sent.push(plain(message)) }, setAttribute() {}, remove() {} };
  const document = { hidden: false, hasFocus: () => true, activeElement: frame, createElement: () => frame, body: { appendChild() {} } };
  const window = {
    navigator: { userActivation: { isActive: true } },
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener() {},
    __TAURI__: {
      core: { convertFileSrc: () => "http://a2plugin.localhost/", invoke: async (name, args) => {
        invoked.push({ name, args: plain(args) });
        if (name === "plugin_hello") return { manifest: { permissions }, run: "test", replay: [] };
        if (name === "plugin_widget_hello") return {};
        return provider ? provider(name, args) : { origin: args.origin, granted: false };
      } },
      webviewWindow: { getCurrentWebviewWindow: () => ({ listen() {} }) },
    },
  };
  vm.runInNewContext(widget ? widgetSource : frameSource, {
    window, document, URL, TextEncoder, console, localStorage: { getItem: () => null, setItem() {} },
  });
  if (widget) await flush();
  else await window.createPluginFrame({ id: "sample", stage: { appendChild() {} }, docked }).start();
  let seq = 0;
  return {
    sent, invoked, window, document, frame,
    call: (call, value = origin, source = frame.contentWindow, extra = {}) =>
      listeners.get("message")({ source, data: { a2: 1, id: ++seq, call, args: [value], ...extra } }),
  };
}

// Minimal DOM for the actual Settings event handlers; no browser/window opens.
class Element {
  constructor() {
    this.children = []; this.className = ""; this.dataset = {}; this.hidden = false;
    this.textContent = ""; this.listeners = new Map(); this.attributes = new Map();
    this.style = { setProperty() {} };
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(" "); },
      toggle: (name, on = !this.classList.contains(name)) => on ? this.classList.add(name) : this.classList.remove(name),
    };
  }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.append(node); }
  prepend(...nodes) { this.children.unshift(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); if (name === "style") this.style = { setProperty() {} }; }
  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(handler);
  }
  removeEventListener(name, handler) { this.listeners.get(name)?.delete(handler); }
  focus() { this.focused = true; }
  click() { return fire(this, "click"); }
  get childElementCount() { return this.children.length; }
  get lastElementChild() { return this.children.at(-1); }
  querySelector(selector) { return descendants(this).find((node) => node.classList.contains(selector.slice(1))) || null; }
}
function descendants(node) { return node.children.flatMap((child) => [child, ...descendants(child)]); }
function fire(node, name, extra = {}) {
  assert.ok(node, "expected element");
  return Promise.all([...node.listeners.get(name) || []].map((fn) => fn({ currentTarget: node, target: node, ...extra })));
}
const prompt = (token = "one") => ({ token, id: "sample", name: "Sample Plugin", version: "1.0.0", folder: "C:/plugins/sample", origin, reviewed: false });

async function settings(initial = null, overrides = {}) {
  const invoked = [], elements = new Map(), events = new Map(), documentEvents = new Map(), registration = [];
  let current = initial;
  const view = { devMode: true, online: true, plugins: [], disabled: [] };
  for (const name of ["pluginDevModeCheckbox", "pluginDevRow", "pluginList", "pluginListEmpty", "pluginCatalog", "pluginCatalogStatus", "pluginAddBtn", "pluginUpdateBtn", "pluginStatus", "pluginConsent", "pluginSearch", "pluginSearchInput", "pluginNoMatch", "pluginInstalledCount", "pluginAvailableCount"]) {
    const element = new Element(); element.className = name; elements.set("." + name, element);
  }
  const consent = elements.get(".pluginConsent"); consent.hidden = true;
  const card = new Element(); card.className = "hotkeyConsentCard"; consent.append(card);
  for (const name of ["hotkeyConsentTitle", "pluginConsentIntro", "pluginConsentList", "pluginConsentNote", "pluginConsentConfirm", "pluginConsentCancel"]) {
    const element = new Element(); element.className = name; card.append(element);
  }
  consent.querySelector(".pluginConsentCancel").textContent = "Cancel";
  const nav = new Element(); nav.addEventListener("click", () => { nav.clicked = true; });
  elements.set('.settingsNavItem[data-section="plugins"]', nav);
  const document = {
    hidden: false, readyState: "complete", querySelector: (selector) => elements.get(selector) || null,
    querySelectorAll: () => [], createElement: () => new Element(),
    addEventListener: (name, fn) => documentEvents.set(name, fn),
  };
  const window = {
    __A2_VIEW__: "settings", A2_PLUGIN_ICON: () => ({ glyph: null, hue: 0, letter: "S" }),
    javaBridge: { getSetting: () => null, setSetting() {} },
    __TAURI__: {
      core: { invoke: async (name, args) => {
        invoked.push({ name, args: plain(args) });
        registration.push(name);
        if (overrides[name]) return overrides[name](args);
        if (name === "plugin_network_prompt") return current;
        if (name === "plugin_answer_network_prompt") { current = null; return { origin, granted: args.allow }; }
        if (name === "plugin_catalog") return [];
        return view;
      } },
      window: { getCurrentWindow: () => ({ listen: (name, handler) => {
        events.set(name, handler); registration.push("listen:" + name);
        return overrides.listen ? overrides.listen(name) : Promise.resolve(() => {});
      } }) },
    },
  };
  vm.runInNewContext(settingsSource, { window, console, document });
  await flush();
  return {
    invoked, registration, consent, document, nav,
    get: (selector) => elements.get(selector),
    setPrompt: (next) => { current = next; },
    query: () => { const result = events.get("plugin-network-prompt")(); return result; },
    hide: async () => { document.hidden = true; documentEvents.get("visibilitychange")(); await flush(); },
    show: async () => { document.hidden = false; documentEvents.get("visibilitychange")(); await flush(); },
    answers: () => invoked.filter(({ name }) => name === "plugin_answer_network_prompt"),
  };
}

test("SDK status and request wait for host decisions and preserve booleans", async () => {
  const h = sdk();
  for (const method of ["permissionStatus", "requestPermission"]) {
    let settled = false;
    const waiting = h.a2.http[method](origin);
    waiting.then(() => { settled = true; });
    assert.deepEqual(h.sent.at(-1).args, [origin]);
    assert.equal(h.sent.at(-1).call, "http." + method);
    await flush();
    assert.equal(settled, false);
    h.answer({ origin, granted: false });
    assert.deepEqual(await waiting, { origin, granted: false });
  }
  const allowed = h.a2.http.requestPermission(origin);
  h.answer({ origin, granted: true });
  assert.deepEqual(await allowed, { origin, granted: true });
  assert.equal(h.a2.http.answerPermission, undefined);
});

test("SDK preserves invalid origin types and propagates older-host errors", async () => {
  const h = sdk();
  const waiting = h.a2.http.requestPermission({ origin });
  assert.deepEqual(h.sent.at(-1).args, [{ origin }]);
  h.answer(undefined, "unknown call http.requestPermission");
  await assert.rejects(waiting, /unknown call/);
});

test("status queries never request consent or require activation", async () => {
  const h = await host({ docked: true });
  h.window.navigator.userActivation.isActive = false;
  h.document.hasFocus = () => false;
  await h.call("http.permissionStatus");
  assert.deepEqual(h.invoked.slice(1), [{ name: "plugin_network_status", args: { origin, plugin: "sample" } }]);
  assert.deepEqual(h.sent.at(-1).result, { origin, granted: false });
});

test("origin calls reject noncanonical, malformed and undeclared origins before IPC", async () => {
  for (const method of ["http.permissionStatus", "http.requestPermission"]) {
    const h = await host();
    for (const value of [null, 2, {}, "https://API.EXAMPLE.COM", origin + "/", origin + ":443", origin + ":8443", origin + "/x", origin + "?x", origin + "#", "http://api.example.com", "https://user@api.example.com", "https://other.example.com", "https://sub.api.example.com", "https://*.example.com", " " + origin]) {
      await h.call(method, value);
      assert.equal(typeof h.sent.at(-1).error, "string", String(value));
    }
    assert.equal(h.invoked.length, 1);
  }
});

test("only trusted activation in the focused active frame may request consent", async () => {
  for (const mutate of [
    (h) => { h.window.navigator.userActivation.isActive = false; },
    (h) => { h.window.navigator.userActivation = undefined; },
    (h) => { h.document.hasFocus = () => false; },
    (h) => { h.document.activeElement = {}; },
    (h) => { h.document.hidden = true; },
  ]) {
    const h = await host();
    mutate(h);
    await h.call("http.requestPermission", origin, h.frame.contentWindow, { userActivation: true, trusted: true });
    assert.match(h.sent.at(-1).error, /active plugin window/);
    assert.equal(h.invoked.length, 1);
  }
});

test("another frame, a widget and a forged resolver call cannot request or grant consent", async () => {
  const h = await host();
  await h.call("http.requestPermission", origin, {});
  assert.equal(h.sent.length, 0);
  await h.call("plugin_answer_network_prompt", { token: "forged", allow: true });
  assert.match(h.sent.at(-1).error, /unknown call/);
  assert.equal(h.invoked.length, 1);
  const widget = await host({ widget: true });
  for (const method of ["http.permissionStatus", "http.requestPermission"]) {
    await widget.call(method);
    assert.match(widget.sent.at(-1).error, /unknown call/);
  }
  assert.equal(widget.invoked.length, 1);
});

test("request remains pending through the decision, binds dock identity and releases on error", async () => {
  const decision = deferred();
  let attempts = 0;
  const h = await host({ docked: true, provider: () => ++attempts === 1 ? decision.promise : { origin, granted: false } });
  const waiting = h.call("http.requestPermission");
  await flush();
  assert.equal(h.sent.length, 0);
  assert.deepEqual(h.invoked.at(-1), { name: "plugin_request_network", args: { origin, plugin: "sample" } });
  await h.call("http.requestPermission");
  assert.match(h.sent.at(-1).error, /already in progress/);
  decision.reject(new Error("plugin source changed"));
  await waiting;
  assert.match(h.sent.at(-1).error, /source changed/);
  await h.call("http.requestPermission");
  assert.deepEqual(h.sent.at(-1).result, { origin, granted: false });
  assert.equal(attempts, 2);
});

test("request returns the native decision and never turns an invalid reply into approval", async () => {
  for (const result of [{ origin, granted: true }, { origin, granted: false }, null, { origin }, { origin, granted: "true" }, { origin: "https://other.example.com", granted: true }]) {
    const h = await host({ provider: () => result });
    await h.call("http.requestPermission");
    if (result?.origin === origin && typeof result.granted === "boolean") assert.deepEqual(h.sent.at(-1).result, result);
    else assert.match(h.sent.at(-1).error, /invalid network permission response/);
  }
});

test("Settings subscribes then queries an existing prompt and defaults to Deny", async () => {
  const h = await settings(prompt());
  assert.ok(h.registration.indexOf("listen:plugin-network-prompt") < h.registration.indexOf("plugin_network_prompt"));
  assert.equal(h.consent.hidden, false);
  assert.equal(h.nav.clicked, true);
  assert.equal(h.consent.querySelector(".pluginConsentCancel").focused, true);
  assert.equal(h.consent.querySelector(".pluginConsentConfirm").focused, undefined);
  assert.equal(h.consent.querySelector(".pluginConsentCancel").textContent, "Deny");
  assert.equal(h.consent.querySelector(".pluginConsentNote").hidden, true);
  assert.equal(h.consent.querySelector(".hotkeyConsentCard").style.overflowWrap, "anywhere");
  const text = h.consent.querySelector(".pluginConsentList").children.map((node) => node.textContent);
  assert.deepEqual(text, ["Plugin: Sample Plugin (sample), version 1.0.0", "Source folder: C:/plugins/sample", "Unreviewed local plugin", "Connect to " + origin + " (can send plugin data and check subscriptions)"]);
  assert.deepEqual(h.answers(), []);
});

test("Settings Allow and Deny answer only the displayed token once and restore card labels", async () => {
  for (const allow of [false, true]) {
    const h = await settings(prompt("opaque-token"));
    const button = h.consent.querySelector(allow ? ".pluginConsentConfirm" : ".pluginConsentCancel");
    await fire(button, "click");
    await fire(button, "click");
    await flush();
    assert.deepEqual(h.answers(), [{ name: "plugin_answer_network_prompt", args: { token: "opaque-token", allow } }]);
    assert.equal(h.consent.hidden, true);
    assert.equal(h.consent.querySelector(".pluginConsentCancel").textContent, "Cancel");
    assert.equal(h.consent.querySelector(".pluginConsentNote").hidden, false);
    assert.equal(h.consent.querySelector(".hotkeyConsentCard").style.overflowWrap, undefined);
  }
});

test("Escape denies without approval", async () => {
  const h = await settings(prompt());
  await fire(h.consent, "keydown", { key: "Escape" });
  await flush();
  assert.deepEqual(h.answers().map(({ args }) => args), [{ token: "one", allow: false }]);
});

test("native cancellation closes only its current card without answering a stale token", async () => {
  const h = await settings(prompt());
  h.setPrompt(null);
  await h.query();
  await flush();
  assert.equal(h.consent.hidden, true);
  await fire(h.consent.querySelector(".pluginConsentConfirm"), "click");
  assert.deepEqual(h.answers(), []);
});

test("replaced token closes the old card and uses host metadata as text", async () => {
  const h = await settings(prompt("old"));
  const replacement = { ...prompt("new"), name: "<img src=x>$& {version}", version: "2.0.0", folder: "C:/new-source/{origin}", reviewed: true };
  h.setPrompt(replacement);
  void h.query();
  await flush();
  assert.equal(h.consent.querySelector(".hotkeyConsentTitle").textContent, "Internet access for <img src=x>$& {version}");
  assert.equal(h.consent.querySelector(".pluginConsentList").children[0].textContent, "Plugin: <img src=x>$& {version} (sample), version 2.0.0");
  assert.equal(h.consent.querySelector(".pluginConsentList").children[1].textContent, "Source folder: C:/new-source/{origin}");
  assert.equal(h.consent.querySelector(".pluginConsentList").children[2].textContent, "Reviewed catalog plugin");
  await fire(h.consent.querySelector(".pluginConsentConfirm"), "click");
  await flush();
  assert.deepEqual(h.answers().map(({ args }) => args), [{ token: "new", allow: true }]);
});

test("late initial query cannot resurrect a prompt after a cancellation event", async () => {
  const first = deferred(); let queries = 0;
  const h = await settings(null, { plugin_network_prompt: () => ++queries === 1 ? first.promise : null });
  await h.query();
  first.resolve(prompt("expired"));
  await flush();
  assert.equal(h.consent.hidden, true);
  assert.deepEqual(h.answers(), []);
});

test("hiding Settings dismisses its card and prevents stale Allow submission", async () => {
  const h = await settings(prompt());
  await h.hide();
  assert.equal(h.consent.hidden, true);
  await fire(h.consent.querySelector(".pluginConsentConfirm"), "click");
  assert.deepEqual(h.answers(), []);
  h.setPrompt(null); // Native hide handler resolves the waiting request false.
  await h.show();
  assert.equal(h.consent.hidden, true);
});

test("native prompt does not hijack installation and is shown after that card closes", async () => {
  const h = await settings(null, { plugin_catalog: () => [{ id: "other", name: "Other Plugin", version: "1.0.0", permissions: ["storage"] }] });
  const installing = fire(h.get(".pluginCatalog").querySelector(".pluginInstallBtn"), "click");
  assert.equal(h.consent.hidden, false);
  const installTitle = h.consent.querySelector(".hotkeyConsentTitle").textContent;
  h.setPrompt(prompt());
  await h.query();
  assert.equal(h.consent.querySelector(".hotkeyConsentTitle").textContent, installTitle);
  assert.equal(h.consent.querySelector(".pluginConsentCancel").textContent, "Cancel");
  await fire(h.consent.querySelector(".pluginConsentCancel"), "click");
  await installing;
  await flush();
  assert.equal(h.consent.querySelector(".hotkeyConsentTitle").textContent, "Internet access for Sample Plugin");
  assert.equal(h.consent.querySelector(".pluginConsentCancel").textContent, "Deny");
  assert.equal(h.invoked.some(({ name }) => name === "plugin_install"), false);
  h.setPrompt(null); await h.query();
});

test("native cancellation does not close an installation card", async () => {
  const h = await settings(null, { plugin_catalog: () => [{ id: "other", name: "Other Plugin", version: "1.0.0", permissions: ["storage"] }] });
  const installing = fire(h.get(".pluginCatalog").querySelector(".pluginInstallBtn"), "click");
  await h.query();
  assert.equal(h.consent.hidden, false);
  assert.equal(h.consent.querySelector(".pluginConsentCancel").textContent, "Cancel");
  await fire(h.consent.querySelector(".pluginConsentCancel"), "click");
  await installing;
});

test("stale-source answer failures are visible without retrying approval", async () => {
  const h = await settings(prompt(), { plugin_answer_network_prompt: () => { throw Error("plugin source changed"); } });
  await fire(h.consent.querySelector(".pluginConsentConfirm"), "click");
  await flush();
  assert.match(h.get(".pluginStatus").textContent, /source changed/);
  assert.equal(h.answers().length, 1);
  assert.equal(h.consent.hidden, true);
});

test("initial query still runs if event registration fails and unsupported hosts remain quiet", async () => {
  const h = await settings(prompt(), { listen: (name) => name === "plugin-network-prompt" ? Promise.reject(Error("events unavailable")) : Promise.resolve() });
  assert.equal(h.consent.hidden, false);
  h.setPrompt(null); await h.query();
  const old = await settings(null, { plugin_network_prompt: () => { throw Error("unknown command plugin_network_prompt"); } });
  assert.equal(old.consent.hidden, true);
  assert.equal(old.get(".pluginStatus").textContent, "");
});

test("all ten consent translations are complete and preserve identity placeholders", () => {
  const locales = ["en", "ko", "ja", "de", "fr", "es", "pt", "ru", "zh-Hant", "zh-Hans"];
  const keys = {
    networkRequestIntro: [], networkRequestIdentity: ["{id}", "{name}", "{version}"],
    networkRequestSource: ["{folder}"], networkRequestReviewed: [], networkRequestUnreviewed: [], networkDeny: [],
  };
  const translated = new Set();
  for (const locale of locales) {
    const labels = JSON.parse(source("src/data/i18n/ui/" + locale + ".json")).settings.plugins;
    for (const [key, placeholders] of Object.entries(keys)) {
      const value = labels[key];
      assert.equal(typeof value, "string", locale + ":" + key);
      assert.ok(value.trim().length > 0 && value.length <= 300, locale + ":" + key);
      assert.deepEqual([...(value.match(/\{[^}]+\}/g) || [])].sort(), placeholders, locale + ":" + key);
    }
    translated.add(labels.networkRequestIntro);
  }
  assert.equal(translated.size, locales.length);
});
