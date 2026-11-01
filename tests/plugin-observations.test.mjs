import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/src/js/pluginFrame.js", import.meta.url), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));

async function host(permissions, docked) {
  const sent = [], calls = [], listeners = new Map();
  const child = {};
  child.postMessage = message => sent.push(plain(message));
  const frame = { contentWindow: child, setAttribute() {}, remove() {} };
  const observations = { schema: "a2-character-observation/v1", status: "waiting" };
  const window = {
    addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener() {},
    __TAURI__: { core: {
      convertFileSrc: () => "http://a2plugin.localhost/",
      invoke: async (name, args) => {
        calls.push({ name, args: plain(args) });
        return { manifest: { permissions }, run: "run", replay: [], observations };
      },
    } },
  };
  vm.runInNewContext(source, {
    window, document: { createElement: () => frame }, URL, TextEncoder, console,
    localStorage: { getItem: () => null, setItem() {} },
  });
  const instance = window.createPluginFrame({ id: "crafting", stage: { appendChild() {} }, docked });
  await instance.start();
  await listeners.get("message")({ source: child, data: { a2: 1, id: 1, call: "ready", args: [] } });
  return { sent, calls, instance, observations };
}

for (const docked of [false, true]) {
  test(`observations need their own permission for initial and live delivery (docked=${docked})`, async () => {
    const denied = await host(["events:character"], docked);
    denied.instance.deliver("observations", { secret: "blocked" });
    assert.equal(denied.sent.some(message => message.event === "observations"), false);
    const allowed = await host(["events:observations"], docked);
    assert.deepEqual(allowed.sent.filter(message => message.event === "observations").map(message => message.data), [allowed.observations]);
    allowed.instance.deliver("observations", { ...allowed.observations, status: "ready" });
    assert.equal(allowed.sent.filter(message => message.event === "observations").at(-1).data.status, "ready");
    assert.deepEqual(allowed.calls[0].args, docked ? { fresh: true, plugin: "crafting" } : { fresh: true });
  });
}

test("observation permission descriptions cover every supported locale", () => {
  for (const locale of ["en", "ko", "ja", "de", "fr", "es", "pt", "ru", "zh-Hant", "zh-Hans"]) {
    const data = JSON.parse(readFileSync(new URL(`../src/data/i18n/ui/${locale}.json`, import.meta.url), "utf8"));
    assert.ok(data.settings.plugins.permObservations?.trim(), locale);
  }
});
