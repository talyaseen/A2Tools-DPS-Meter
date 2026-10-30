import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/src/js/core.js", import.meta.url), "utf8");

// The meter between fights: it keeps the last fight's rows, but a party
// change (partyGeneration) replaces them.
function meter() {
  const shown = [];
  let resets = 0;
  const context = vm.createContext({
    console: { log() {} },
    window: { addEventListener() {}, javaBridge: { updateOverlaySize() {} } },
    document: {
      readyState: "loading", addEventListener() {},
      documentElement: { classList: { toggle() {} } }, body: { classList: { toggle() {} } },
    },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    cachedDpsJson: null,
  });
  vm.runInContext(source, context);
  vm.runInContext("window.dpsData = { getDpsData: () => cachedDpsJson };", context);
  const app = vm.runInContext("new DpsApp()", context);
  // These tests cover retention of the complete canonical fight. The group
  // view separately drops cached players absent from current membership.
  app.audience = 'everyone';
  app.elList = { querySelector: () => ({}) };
  app.detailsUI = { close() {}, isOpen: () => false };
  app.meterUI = {
    updateFromRows(rows) { shown.push(Array.from(rows, (r) => r.name).sort()); },
    onResetMeterUi() { resets++; shown.push([]); },
  };
  app.battleTime = { setVisible() {}, update() {} };
  for (const method of ["applyLocalPlayerIdUpdate", "updateLocalPlayerIdentity", "updateConnectionStatusUi", "updateBossHpBar", "updateMeterTotalBar", "logDebug"]) app[method] = () => {};
  app.isOutOfCombatState = () => true;
  app.getTargetLabel = () => "";
  app.getRowsSummary = () => ({ listSignature: "" });
  const send = (names, partyGeneration) => {
    const map = Object.fromEntries(names.map((name, i) => [90000001 + i, { nickname: name, job: "Chanter", dps: 0, amount: 0, isPartyMember: true, isLocalPlayer: name === "Nullception" }]));
    context.cachedDpsJson = JSON.stringify({ targetMode: "bossTargets", targetId: 0, battleTime: 0, map, partyGeneration, audienceKnown: true });
    app.fetchDps();
    return shown.at(-1);
  };
  return { send, resets: () => resets };
}

test("someone joining between fights shows, and the same party resent changes nothing", () => {
  const m = meter();
  assert.deepEqual(m.send(["Nullception", "Real"], 1), ["Nullception", "Real"]);
  // Kept rows win while the party is the same.
  assert.deepEqual(m.send(["Nullception"], 1), ["Nullception", "Real"]);
  assert.deepEqual(m.send(["Boushii", "Nullception", "Real"], 2), ["Boushii", "Nullception", "Real"]);
});

test("the party ending clears the meter instead of keeping the old party", () => {
  const m = meter();
  m.send(["Nullception", "Real", "Boushii"], 1);
  assert.deepEqual(m.send([], 2), []);
  assert.equal(m.resets(), 1);
  // Kept that way while nothing new comes.
  m.send([], 2);
  assert.deepEqual(m.send(["Nullception"], 2), ["Nullception"]);
});
