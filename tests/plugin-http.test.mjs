import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const sdkSource = readFileSync(new URL("../src-tauri/src/plugins/a2.js", import.meta.url), "utf8");
const frameSource = readFileSync(new URL("../public/src/js/pluginFrame.js", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("../public/src/js/pluginSettings.js", import.meta.url), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

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

async function host(permissions = [], { docked = false, provider = async () => ({ status: 200, body: "{}", contentType: "application/json", fetchedAt: 123 }) } = {}) {
  const sent = [], invoked = [], listeners = new Map();
  const frame = { contentWindow: { postMessage: (message) => sent.push(plain(message)) }, setAttribute() {}, remove() {} };
  const window = {
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
    __TAURI__: { core: {
      convertFileSrc: () => "http://a2plugin.localhost/",
      invoke: async (name, args) => {
        invoked.push({ name, args: plain(args) });
        if (name === "plugin_hello") return { manifest: { permissions }, run: "test-run", replay: [] };
        return provider(name, args);
      },
    } },
  };
  vm.runInNewContext(frameSource, {
    window, document: { createElement: () => frame }, URL, TextEncoder, console,
    localStorage: { getItem: () => null, setItem() {} },
  });
  const instance = window.createPluginFrame({ id: "network-test", stage: { appendChild() {} }, docked });
  await instance.start();
  let seq = 0;
  return {
    sent, invoked, instance,
    request: (options, source = frame.contentWindow) =>
      listeners.get("message")({ source, data: { a2: 1, id: ++seq, call: "http.request", args: [options] } }),
  };
}

test("HTTP SDK sends explicit request options and returns status/body metadata unchanged", async () => {
  const h = sdk();
  assert.equal(Object.isFrozen(h.a2.http), true);
  const options = { url: "https://api.example.com/subscription", method: "POST", json: { product: "market" }, bearer: "sample-token" };
  const pending = h.a2.http.request(options);
  assert.deepEqual(h.sent.at(-1), { a2: 1, id: 1, call: "http.request", args: [options] });
  const answer = { status: 401, body: '{"active":false}', contentType: "application/json", fetchedAt: 12345 };
  h.answer(answer);
  assert.deepEqual(await pending, answer);
  const failed = h.a2.http.request({ url: "https://api.example.com/" });
  h.answer(undefined, "HTTP request timed out");
  await assert.rejects(failed, /HTTP request timed out/);
});

test("frame refuses internet and subscription requests without an exact-origin permission", async () => {
  const h = await host(["feed:boss-timers", "storage", "network:https://*.example.com"]);
  await h.request({ url: "https://api.example.com/prices" });
  await h.request({ url: "https://api.example.com/subscription", method: "POST", json: { product: "market" }, bearer: "sample-token" });
  assert.equal(h.invoked.length, 1);
  assert.equal(h.sent.length, 2);
  for (const answer of h.sent) assert.match(answer.error, /network:https:\/\/api\.example\.com/);
});

test("frame binds a normalized permitted origin and includes its dock identity", async () => {
  const h = await host(["network:https://api.example.com"], { docked: true });
  await h.request({ url: "https://API.EXAMPLE.COM:443/prices?item=5" });
  await h.request({ url: "https://api.example.com/subscription", method: "POST", json: { product: "market" }, bearer: "sample-token" });
  assert.deepEqual(h.invoked.slice(1), [
    { name: "plugin_http_request", args: { request: { url: "https://api.example.com/prices?item=5", method: "GET" }, plugin: "network-test" } },
    { name: "plugin_http_request", args: { request: { url: "https://api.example.com/subscription", method: "POST", json: '{"product":"market"}', bearer: "sample-token" }, plugin: "network-test" } },
  ]);
  assert.equal(h.sent[1].result.status, 200);
});

test("an origin permission does not include subdomains or lookalikes", async () => {
  const h = await host(["network:https://api.example.com"]);
  for (const url of ["https://sub.api.example.com/", "https://api.example.com.evil.test/"]) {
    await h.request({ url });
    assert.match(h.sent.at(-1).error, /lacks.*permission/);
  }
  assert.equal(h.invoked.length, 1);
});

test("non-default HTTPS ports remain refused even when the manifest declares one", async () => {
  const withPort = await host(["network:https://api.example.com:8443"]);
  await withPort.request({ url: "https://api.example.com:8443/" });
  assert.match(withPort.sent.at(-1).error, /port 443/);
  assert.equal(withPort.invoked.length, 1);
});

test("frame rejects unsupported schemes, URL credentials and fragments before IPC", async () => {
  const h = await host(["network:https://api.example.com"]);
  for (const url of ["http://api.example.com/", "file:///tmp/item", "https://user:pass@api.example.com/", "https://api.example.com/#secret", "https://api.example.com/#"]) {
    await h.request({ url });
    assert.match(h.sent.at(-1).error, /HTTPS URLs without credentials or fragments/);
  }
  assert.equal(h.invoked.length, 1);
});

test("frame rejects malformed request options and arbitrary headers without coercion", async () => {
  const h = await host(["network:https://api.example.com"]);
  const url = "https://api.example.com/";
  for (const options of [
    null, [], {}, { url: 1 }, { url, method: "DELETE" }, { url, method: "get" },
    { url, headers: { Cookie: "sample" } }, { url, body: "sample" },
    { url, credentials: "include" }, { url, json: null },
    { url, bearer: "" }, { url, bearer: 123 }, { url, bearer: "sample\r\nx: y" },
  ]) {
    await h.request(options);
    assert.equal(typeof h.sent.at(-1).error, "string");
  }
  assert.equal(h.invoked.length, 1);
  await h.request({ url, method: "POST", json: null });
  assert.equal(h.invoked.length, 2);
  assert.deepEqual(h.invoked.at(-1).args.request, { url, method: "POST", json: "null" });
});

test("another frame cannot use a permitted plugin's HTTP request", async () => {
  const h = await host(["network:https://api.example.com"]);
  await h.request({ url: "https://api.example.com/" }, {});
  assert.equal(h.invoked.length, 1);
  assert.equal(h.sent.length, 0);
});

test("one pending request per frame rejects overlap and releases after a failure", async () => {
  let reject, attempts = 0;
  const h = await host(["network:https://api.example.com"], {
    provider: () => ++attempts === 1 ? new Promise((_, no) => { reject = no; }) : { status: 200, body: "ok", contentType: "text/plain", fetchedAt: 99 },
  });
  const first = h.request({ url: "https://api.example.com/prices" });
  await h.request({ url: "https://api.example.com/subscription" });
  assert.match(h.sent.at(-1).error, /already in progress/);
  assert.equal(attempts, 1);
  reject(new Error("provider timed out"));
  await first;
  assert.match(h.sent.at(-1).error, /provider timed out/);
  await h.request({ url: "https://api.example.com/subscription" });
  assert.equal(attempts, 2);
  assert.equal(h.sent.at(-1).result.body, "ok");
});

test("network consent names the origin in all ten supported languages", () => {
  const locales = ["en", "ko", "ja", "de", "fr", "es", "pt", "ru", "zh-Hant", "zh-Hans"];
  const values = locales.map((locale) => {
    const ui = JSON.parse(readFileSync(new URL("../src/data/i18n/ui/" + locale + ".json", import.meta.url), "utf8"));
    const text = ui.settings.plugins.permNetwork;
    assert.equal(typeof text, "string", locale);
    assert.ok(text.length > 0 && text.length <= 300, locale);
    assert.ok(text.includes("{origin}"), locale);
    assert.equal(ui.settings.plugins.permMarketPrices, undefined);
    return text;
  });
  assert.equal(new Set(values).size, 10);
});

test("frame enforces raw and normalized URL length before IPC", async () => {
  const h = await host(["network:https://api.example.com"]);
  const base = "https://api.example.com/";
  await h.request({ url: base + "a".repeat(4096 - base.length) });
  assert.equal(h.invoked.length, 2);
  await h.request({ url: base + "a".repeat(4097 - base.length) });
  assert.match(h.sent.at(-1).error, /4096/);
  await h.request({ url: base + "é".repeat(1000) });
  assert.match(h.sent.at(-1).error, /4096/);
  assert.equal(h.invoked.length, 2);
});

test("frame accepts only bounded RFC6750 bearer characters", async () => {
  const h = await host(["network:https://api.example.com"]);
  const url = "https://api.example.com/";
  await h.request({ url, bearer: "a".repeat(4096) });
  await h.request({ url, bearer: "Az09-._~+/=" });
  assert.equal(h.invoked.length, 3);
  for (const bearer of ["a".repeat(4097), "two words", "é", "token:", "token\t", "token\n", "token\r\n"]) {
    await h.request({ url, bearer });
    assert.match(h.sent.at(-1).error, /invalid bearer token/);
  }
  assert.equal(h.invoked.length, 3);
});

test("frame limits serialized JSON by UTF-8 bytes, including multibyte boundary", async () => {
  const h = await host(["network:https://api.example.com"]);
  const url = "https://api.example.com/";
  await h.request({ url, method: "POST", json: "a".repeat(65534) });
  await h.request({ url, method: "POST", json: "é".repeat(32767) });
  assert.equal(h.invoked.length, 3);
  for (const json of ["a".repeat(65535), "é".repeat(32768)]) {
    await h.request({ url, method: "POST", json });
    assert.match(h.sent.at(-1).error, /64 KiB/);
  }
  assert.equal(h.invoked.length, 3);
});

test("nonserializable and cyclic JSON never reaches IPC", async () => {
  const h = await host(["network:https://api.example.com"]);
  const cycle = {}; cycle.self = cycle;
  for (const json of [undefined, 1n, cycle]) {
    await h.request({ url: "https://api.example.com/", method: "POST", json });
    assert.match(h.sent.at(-1).error, /not serializable/);
  }
  assert.equal(h.invoked.length, 1);
});

// Run the actual Settings card handlers without loading a desktop or plugin.
class Element {
  constructor() {
    this.children = []; this.className = ""; this.dataset = {}; this.hidden = false;
    this.textContent = ""; this.listeners = new Map(); this.style = { setProperty() {} };
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
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(handler);
  }
  removeEventListener(name, handler) { this.listeners.get(name)?.delete(handler); }
  focus() {}
  get childElementCount() { return this.children.length; }
  get lastElementChild() { return this.children.at(-1); }
  querySelector(selector) { return descendants(this).find((node) => node.classList.contains(selector.slice(1))) || null; }
}
function descendants(node) { return node.children.flatMap((child) => [child, ...descendants(child)]); }
function click(node) {
  assert.ok(node, "expected button");
  return Promise.all([...node.listeners.get("click") || []].map((fn) => fn({ currentTarget: node, target: node })));
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const networkOrigin = "network:https://api.example.com";
function consentView(reviewed = true) {
  return {
    devMode: true, online: true, disabled: [],
    plugins: [{ id: "test", name: "Test Plugin", version: "1.0.0", reviewed, path: "C:/plugin", permissions: ["storage", networkOrigin] }],
    networkPermissions: { test: { source: "opaque-source", approved: [], pending: [networkOrigin] } },
  };
}
async function settings(initial, overrides = {}) {
  const invoked = [], elements = new Map(), events = new Map();
  let current = initial;
  for (const name of ["pluginDevModeCheckbox", "pluginDevRow", "pluginList", "pluginListEmpty", "pluginCatalog", "pluginCatalogStatus", "pluginAddBtn", "pluginUpdateBtn", "pluginStatus", "pluginConsent", "pluginSearch", "pluginSearchInput", "pluginNoMatch", "pluginInstalledCount", "pluginAvailableCount"]) {
    const element = new Element(); element.className = name; elements.set("." + name, element);
  }
  const consent = elements.get(".pluginConsent"); consent.hidden = true;
  for (const name of ["hotkeyConsentTitle", "pluginConsentIntro", "pluginConsentList", "pluginConsentConfirm", "pluginConsentCancel"]) {
    const element = new Element(); element.className = name; consent.append(element);
  }
  const window = {
    __A2_VIEW__: "settings", A2_PLUGIN_ICON: () => ({ glyph: null, hue: 0, letter: "P" }),
    javaBridge: { getSetting: () => null, setSetting() {} },
    __TAURI__: {
      core: { invoke: async (name, args) => {
        invoked.push({ name, args: args === undefined ? undefined : plain(args) });
        if (overrides[name]) return overrides[name](args);
        if (name === "plugin_catalog") return [];
        if (name === "plugin_approve_network") {
          const network = current.networkPermissions.test;
          current = { ...current, networkPermissions: { test: { ...network, approved: [...args.permissions], pending: [] } } };
        }
        if (name === "plugin_revoke_network") {
          const network = current.networkPermissions.test;
          current = { ...current, networkPermissions: { test: { ...network, approved: [], pending: [networkOrigin] } } };
        }
        return current;
      } },
      window: { getCurrentWindow: () => ({ listen: (name, handler) => { events.set(name, handler); return Promise.resolve(() => {}); } }) },
    },
  };
  vm.runInNewContext(settingsSource, {
    window, console, document: {
      readyState: "complete", querySelector: (selector) => elements.get(selector) || null,
      querySelectorAll: () => [], createElement: () => new Element(), addEventListener() {},
    },
  });
  await flush();
  return {
    invoked, consent, get: (selector) => elements.get(selector),
    button: (name) => elements.get(".pluginList").querySelector("." + name),
    refresh: async (next) => { current = next; events.get("plugins-changed")(); await flush(); },
  };
}

test("catalog and developer plugins both require explicit origin consent", async () => {
  for (const reviewed of [true, false]) {
    const h = await settings(consentView(reviewed));
    assert.ok(h.button("pluginNetworkAllowBtn"));
    assert.equal(h.button("pluginNetworkRevokeBtn"), null);
    assert.equal(h.invoked.some(({ name }) => name === "plugin_approve_network"), false);
    assert.equal(descendants(h.get(".pluginList")).some((node) => node.textContent.includes("api.example.com")), false, "pending origin must not be listed as granted");
    const asking = click(h.button("pluginNetworkAllowBtn"));
    assert.equal(h.consent.hidden, false);
    assert.equal(h.consent.querySelector(".hotkeyConsentTitle").textContent, "Internet access for Test Plugin");
    assert.match(h.consent.querySelector(".pluginConsentIntro").textContent, /send its data/);
    assert.deepEqual(h.consent.querySelector(".pluginConsentList").children.map((node) => node.textContent), ["Connect to https://api.example.com (can send plugin data and check subscriptions)"]);
    await click(h.consent.querySelector(".pluginConsentCancel"));
    await asking;
    assert.equal(h.consent.hidden, true);
    assert.equal(h.invoked.some(({ name }) => name === "plugin_approve_network"), false);
  }
});

test("confirmation sends only the exact displayed origin list and source, even after refresh", async () => {
  const original = consentView();
  const h = await settings(original);
  const asking = click(h.button("pluginNetworkAllowBtn"));
  original.networkPermissions.test.pending.push("network:https://new.example.com");
  original.networkPermissions.test.source = "changed-source";
  await h.refresh(original);
  await click(h.button("pluginNetworkAllowBtn")); // does not replace an open consent card
  assert.equal(h.consent.querySelector(".pluginConsentList").children.length, 1);
  await click(h.consent.querySelector(".pluginConsentConfirm"));
  await asking;
  assert.deepEqual(h.invoked.filter(({ name }) => name === "plugin_approve_network"), [
    { name: "plugin_approve_network", args: { id: "test", source: "opaque-source", permissions: [networkOrigin] } },
  ]);
  assert.ok(h.button("pluginNetworkRevokeBtn"));
});

test("revocation uses the plugin source and refreshes available controls", async () => {
  for (const reviewed of [true, false]) {
    const initial = consentView(reviewed);
    initial.networkPermissions.test = { source: "opaque-source", approved: [networkOrigin], pending: [] };
    const h = await settings(initial);
    assert.equal(h.button("pluginNetworkAllowBtn"), null);
    await click(h.button("pluginNetworkRevokeBtn"));
    assert.deepEqual(h.invoked.filter(({ name }) => name === "plugin_revoke_network"), [
      { name: "plugin_revoke_network", args: { id: "test", source: "opaque-source" } },
    ]);
    assert.ok(h.button("pluginNetworkAllowBtn"));
    assert.equal(h.button("pluginNetworkRevokeBtn"), null);
    assert.equal(h.invoked.some(({ name }) => name === "plugin_approve_network"), false);
  }
});

test("grant and revoke failures remain visible and do not claim success", async () => {
  const h = await settings(consentView(), { plugin_approve_network: () => { throw Error("plugin source changed"); } });
  const asking = click(h.button("pluginNetworkAllowBtn"));
  await click(h.consent.querySelector(".pluginConsentConfirm"));
  await asking;
  assert.match(h.get(".pluginStatus").textContent, /source changed/);
  assert.ok(h.get(".pluginStatus").classList.contains("pluginError"));
  assert.equal(h.button("pluginNetworkRevokeBtn"), null);
  const approved = consentView(); approved.networkPermissions.test = { source: "opaque-source", approved: [networkOrigin], pending: [] };
  const failingRevoke = await settings(approved, { plugin_revoke_network: () => { throw Error("could not save grants"); } });
  await click(failingRevoke.button("pluginNetworkRevokeBtn"));
  assert.match(failingRevoke.get(".pluginStatus").textContent, /could not save grants/);
  assert.ok(failingRevoke.button("pluginNetworkRevokeBtn"));
});

test("network grant controls are absent without grant metadata or on invalid plugins", async () => {
  const initial = consentView(); delete initial.networkPermissions;
  const absent = await settings(initial);
  assert.equal(absent.button("pluginNetworkAllowBtn"), null);
  assert.equal(absent.button("pluginNetworkRevokeBtn"), null);
  const invalid = consentView(); invalid.plugins[0].error = "invalid manifest";
  const h = await settings(invalid);
  assert.equal(h.button("pluginNetworkAllowBtn"), null);
});

test("a catalog install cannot overwrite an active network consent card", async () => {
  const h = await settings(consentView(), {
    plugin_catalog: () => [{ id: "other", name: "Other Plugin", version: "1.0.0", permissions: ["storage"] }],
  });
  const asking = click(h.button("pluginNetworkAllowBtn"));
  await click(h.get(".pluginCatalog").querySelector(".pluginInstallBtn"));
  assert.equal(h.consent.querySelector(".hotkeyConsentTitle").textContent, "Internet access for Test Plugin");
  assert.equal(h.consent.querySelector(".pluginConsentList").children.length, 1);
  assert.match(h.consent.querySelector(".pluginConsentList").children[0].textContent, /https:\/\/api\.example\.com/);
  await click(h.consent.querySelector(".pluginConsentConfirm"));
  await asking;
  assert.equal(h.invoked.some(({ name }) => name === "plugin_install"), false);
  assert.equal(h.invoked.filter(({ name }) => name === "plugin_approve_network").length, 1);
});

test("all ten locales translate internet consent actions and retain the plugin name placeholder", () => {
  for (const locale of ["en", "ko", "ja", "de", "fr", "es", "pt", "ru", "zh-Hant", "zh-Hans"]) {
    const strings = JSON.parse(readFileSync(new URL("../src/data/i18n/ui/" + locale + ".json", import.meta.url), "utf8")).settings.plugins;
    for (const key of ["networkAllow", "networkRevoke", "networkConsentTitle", "networkConsentIntro", "networkConfirm"]) {
      assert.equal(typeof strings[key], "string", locale + ":" + key);
      assert.ok(strings[key].trim().length > 0 && strings[key].length <= 300, locale + ":" + key);
    }
    assert.ok(strings.networkConsentTitle.includes("{name}"), locale);
  }
});
