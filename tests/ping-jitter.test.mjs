import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const core = readFileSync(new URL("../public/src/js/core.js", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../public/src/js/tauriBridge.js", import.meta.url), "utf8");

function setup() {
  const classes = new Set();
  const text = { textContent: "" };
  const jitter = { hidden: true, textContent: "", title: "", attributes: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    removeAttribute(key) { delete this.attributes[key]; } };
  const window = { addEventListener() {}, javaBridge: { getPingMs: () => 80, getJitterMs: () => null } };
  const context = vm.createContext({ window, document: { readyState: "loading", addEventListener() {} } });
  vm.runInContext(core, context);
  const app = window.dpsApp;
  app.showPing = true;
  app.pingEl = { querySelector: (s) => s === ".pingText" ? text : jitter,
    classList: { add: (...names) => names.forEach((s) => classes.add(s)),
      remove: (...names) => names.forEach((s) => classes.delete(s)) } };
  return { app, window, classes, text, jitter };
}

test("jitter renders compactly beside ping, including a valid zero", () => {
  const { app, window, classes, text, jitter } = setup();
  for (const [value, expected] of [[0, "J 0.0ms"], [2.375, "J 2.4ms"]]) {
    window.javaBridge.getJitterMs = () => value;
    app.updatePing(79);
    assert.equal(text.textContent, "79ms");
    assert.equal(jitter.textContent, expected);
    assert.equal(jitter.hidden, false);
    assert.ok(classes.has("isVisible"));
    assert.ok(classes.has("ping-good"));
    assert.equal(jitter.attributes["aria-label"], jitter.title);
    assert.ok(jitter.title.includes(value.toFixed(1)));
  }
});

test("unknown, reset and invalid jitter never display as a zero or a stale value", () => {
  const { app, window, jitter, text } = setup();
  for (const value of [null, undefined, -1, NaN, Infinity, "2.4"]) {
    window.javaBridge.getJitterMs = () => 6;
    app.updatePing();
    window.javaBridge.getJitterMs = () => value;
    app.updatePing();
    assert.equal(jitter.hidden, true);
    assert.equal(jitter.textContent, "");
    assert.equal(jitter.title, "");
    assert.equal(jitter.attributes["aria-label"], undefined);
    assert.equal(text.textContent, "80ms");
  }
});

test("the existing ping toggle and unknown ping hide the entire display", () => {
  const { app, window, classes } = setup();
  window.javaBridge.getJitterMs = () => 5;
  app.updatePing();
  app.showPing = false;
  app.updatePing();
  assert.ok(!classes.has("isVisible"));
  app.showPing = true;
  app.updatePing();
  assert.ok(classes.has("isVisible"));
  for (const ping of [null, undefined, -1, NaN, Infinity]) {
    window.javaBridge.getPingMs = () => ping;
    app.updatePing();
    assert.ok(!classes.has("isVisible"));
  }
});

test("the jitter explanation follows localization without changing its metric", () => {
  const { app, window, jitter } = setup();
  window.javaBridge.getJitterMs = () => 3.25;
  app.i18n = { t: (key) => { assert.equal(key, "meter.jitterTip"); return "Gigue : {value} ms."; } };
  app.updatePing();
  assert.equal(jitter.textContent, "J 3.3ms");
  assert.equal(jitter.title, "Gigue : 3.3 ms.");
});

test("the bridge caches server jitter independently of repeated ping refresh events", () => {
  const handlers = new Map();
  const pushes = [];
  const context = vm.createContext({ viewMode: "main", listen: (event, fn) => handlers.set(event, fn),
    window: { _dpsApp: { updatePing: (ms) => pushes.push(ms) } } });
  const start = bridge.indexOf('  if (viewMode !== "settings") listen("ping-update"');
  const end = bridge.indexOf('  listen("capture-status-changed"', start);
  assert.ok(start >= 0 && end > start);
  const gettersStart = bridge.indexOf("    getPingMs() {");
  const gettersEnd = bridge.indexOf("    // --- Connection Info ---", gettersStart);
  vm.runInContext("let cachedPing = null, cachedJitter = null;\n" + bridge.slice(start, end)
    + "\nthis.bridge = {\n" + bridge.slice(gettersStart, gettersEnd) + "\n};", context);
  assert.equal(context.bridge.getJitterMs(), null);
  handlers.get("jitter-update")({ payload: 2.4 });
  for (let n = 0; n < 5; n++) handlers.get("ping-update")({ payload: 80 });
  assert.equal(context.bridge.getJitterMs(), 2.4, "UI broadcasts do not become new RTT samples");
  assert.equal(context.bridge.getPingMs(), 80, "the numeric ping contract stays unchanged");
  assert.deepEqual(pushes, [undefined, 80, 80, 80, 80, 80]);
  handlers.get("jitter-update")({ payload: null });
  assert.equal(context.bridge.getJitterMs(), null);
});

test("all ten locales explain the jitter value and sample window", () => {
  for (const locale of ["en", "ko", "ja", "de", "fr", "es", "pt", "ru", "zh-Hant", "zh-Hans"]) {
    const value = JSON.parse(readFileSync(new URL(`../src/data/i18n/ui/${locale}.json`, import.meta.url), "utf8")).meter.jitterTip;
    assert.ok(value.includes("{value}"), locale);
    assert.ok(value.includes("10"), locale);
    assert.ok(value.length > 20, locale);
  }
});
