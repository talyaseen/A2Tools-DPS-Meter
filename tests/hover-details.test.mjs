import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/src/js/core.js", import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(getBattleDetail) {
  const logs = [];
  const frames = new Map();
  let nextFrame = 0;
  const window = { addEventListener() {}, dpsData: { getBattleDetail }, javaBridge: { logToDebug: (s) => logs.push(s) } };
  const context = vm.createContext({ window, console, document: { readyState: "loading", addEventListener() {} },
    requestAnimationFrame: (callback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id) => frames.delete(id),
  });
  vm.runInContext(source, context);
  const app = vm.runInContext("Object.create(DpsApp.prototype)", context);
  // These timing tests exercise an explicitly unfiltered view with four
  // displayed synthetic players. Audience membership is covered separately.
  app.audience = 'everyone';
  app.latestRowsById = new Map([1, 2, 3, 4].map(id => [String(id), { id }]));
  app.dpsFormatter = new Intl.NumberFormat("en-US");
  app.elList = { querySelector: () => ({}) };
  app.hoveredDetailsRowId = 1;
  app.hoverTooltipCacheByRowId = new Map();
  app.hoverTooltipPendingRowIds = new Set();
  app.hoverTooltipRequestSeqByRowId = new Map();
  const rendered = [];
  app.renderHoverTooltip = (details) => rendered.push(details);
  const flushFrame = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback());
  };
  return { app, rendered, logs, window, frames, flushFrame };
}

test("hover replaces loading with the player's highest-damage skills", async () => {
  const { app, rendered } = setup(async () => JSON.stringify({
    battleTime: 10000,
    skills: Array.from({ length: 7 }, (_, i) => ({ code: 18010000 + i * 10000, name: `Skill ${i}`, dmg: 100 * (i + 1), time: 1, actorId: 1 })),
  }));
  app.applyHoverTooltip({ id: 1 }, { forceRefresh: true });
  assert.equal(rendered[0].state, "loading");
  await tick();
  assert.equal(rendered.at(-1).skills.length, 5);
  assert.equal(rendered.at(-1).skills[0].dmg, 700);
  assert.notEqual(rendered.at(-1).state, "loading");
});

test("an empty response does not leave a perpetual loading state", async () => {
  const { app, rendered } = setup(async () => null);
  app.applyHoverTooltip({ id: 1 }, { forceRefresh: true });
  await tick();
  assert.equal(rendered.at(-1).skills.length, 0);
  assert.notEqual(rendered.at(-1).state, "loading");
});

test("request failures are visible and logged instead of masquerading as loading", async () => {
  const { app, rendered, logs } = setup(async () => { throw new Error("IPC failed"); });
  app.applyHoverTooltip({ id: 1 }, { forceRefresh: true });
  await tick();
  assert.equal(rendered.at(-1).state, "error");
  assert.match(logs[0], /IPC failed/);
});

test("rendered tooltip text distinguishes loading, empty data and errors", () => {
  const { app } = setup();
  app.hoverTooltipEl = { style: {}, setAttribute() {}, classList: { add() {} }, offsetWidth: 100, offsetHeight: 100 };
  const render = Object.getPrototypeOf(app).renderHoverTooltip;
  const row = { id: 1, name: "Test", dps: 100, totalDamage: 1000 };
  for (const [state, text] of [["loading", "Loading..."], ["empty", "No skill data for this fight"], ["error", "Could not load skills"]]) {
    render.call(app, { skills: [], state }, row, {});
    assert.ok(app.hoverTooltipEl.innerHTML.includes(text));
    if (state !== "loading") assert.ok(!app.hoverTooltipEl.innerHTML.includes("Loading..."));
  }
});

const bridgeSource = readFileSync(new URL("../public/src/js/tauriBridge.js", import.meta.url), "utf8");
const battleDetailMethod = bridgeSource.slice(bridgeSource.indexOf("    async getBattleDetail("), bridgeSource.indexOf("\n    getVersion()"));

function bridge(snapshot, responses) {
  const calls = [];
  const context = vm.createContext({
    cachedDpsJson: JSON.stringify(snapshot), lastSkillDetailsIssue: "", window: {},
    invoke: async (command, args) => {
      assert.equal(command, "get_skill_details");
      calls.push(args);
      return responses[args.targetId];
    },
  });
  const api = vm.runInContext(`({${battleDetailMethod}})`, context);
  return { api, calls };
}

test("hover queries the retained fight when the active target is zero", async () => {
  const { api, calls } = bridge({ targetId: 0, detailTargetIds: [42] }, {
    42: { skills: [{ code: 11010000, actorId: 1, dmg: 500, time: 1 }] },
  });
  const { app, rendered } = setup((id) => api.getBattleDetail(id));
  app.applyHoverTooltip({ id: 1 }, { forceRefresh: true });
  await tick();
  assert.equal(calls[0].targetId, 42);
  assert.equal(calls[0].actorIds[0], 1);
  assert.equal(rendered.at(-1).skills[0].dmg, 500);
});

test("multi-target hover combines repeated skills and keeps damage-over-time separate", async () => {
  const skill = { code: 11010000, actorId: 1, dmg: 500, time: 1, minDmg: 500, maxDmg: 500, hitTimestamps: [0], specs: [true] };
  const { api, calls } = bridge({ targetId: 0, detailTargetIds: [42, 43, 42], battleTime: 2000 }, {
    42: { startTime: 1000, totalTargetDamage: 500, skills: [skill] },
    43: { startTime: 2000, totalTargetDamage: 1000, skills: [{ ...skill, dmg: 700, minDmg: 700, maxDmg: 700 }, { ...skill, dmg: 300, isDot: true }] },
  });
  const detail = JSON.parse(await api.getBattleDetail(1));
  assert.equal(calls.length, 2);
  assert.equal(detail.skills.length, 2);
  assert.equal(detail.skills[0].dmg, 1200);
  assert.equal(detail.skills[0].time, 2);
  assert.equal(detail.skills[0].minDmg, 500);
  assert.equal(detail.skills[0].maxDmg, 700);
  assert.deepEqual(detail.skills[0].hitTimestamps, [0, 1000]);
  assert.equal(detail.totalTargetDamage, 1500);
  assert.equal(detail.battleTime, 2000);
});

test("reset snapshots do not query an old target and legacy snapshots still work", async () => {
  const reset = bridge({ targetId: 0, detailTargetIds: [] }, {});
  assert.equal(await reset.api.getBattleDetail(1), null);
  assert.equal(reset.calls.length, 0);
  const legacy = bridge({ targetId: 42 }, { 42: { skills: [] } });
  await legacy.api.getBattleDetail(1);
  assert.equal(legacy.calls[0].targetId, 42);
});


test("tooltip follows pointer coordinates relative to its container and flips at screen edges", () => {
  const { app, window } = setup();
  window.screen = { availLeft: -1280, availTop: 0, availWidth: 1280, availHeight: 720 };
  window.screenX = -700;
  window.screenY = 100;
  let updates = 0;
  window.javaBridge.updateOverlaySize = () => updates++;
  app.hoverTooltipEl = {
    style: {}, offsetWidth: 240, offsetHeight: 180,
    offsetParent: { getBoundingClientRect: () => ({ left: 10, top: 5 }) },
  };
  app.hoverMousePos = { x: 100, y: 80 };
  app.positionHoverTooltip();
  assert.equal(app.hoverTooltipEl.style.transform, "translate3d(102px, 87px, 0)");
  app.hoverMousePos = { x: 550, y: 550 };
  app.positionHoverTooltip();
  assert.equal(app.hoverTooltipEl.style.transform, "translate3d(288px, 353px, 0)");
  assert.equal(updates, 1, "pointer movement must not resize the native window");
  app.hoverTooltipEl.offsetHeight = 200;
  app.positionHoverTooltip();
  assert.equal(updates, 2, "content size changes still resize the window");
});

test("moving over the same row repositions the tooltip without fetching skills again", () => {
  const { app, flushFrame, frames } = setup();
  app.pinnedDetailsRowId = null;
  app.shouldSuppressRowInteractions = () => false;
  app.hoverTooltipEl = { classList: { contains: () => true } };
  let positions = 0;
  app.positionHoverTooltip = () => positions++;
  app.applyHoverTooltip = () => assert.fail("unexpected refetch");
  app.openHoverDetailsRow({ id: 1 }, { clientX: 120, clientY: 80 });
  app.openHoverDetailsRow({ id: 1 }, { clientX: 140, clientY: 90 });
  assert.equal(app.hoverMousePos.x, 140);
  assert.equal(app.hoverMousePos.y, 90);
  assert.equal(positions, 0);
  assert.equal(frames.size, 1);
  flushFrame();
  assert.equal(positions, 1);
});

const sizingSource = bridgeSource.slice(bridgeSource.indexOf("  const updateWindowSize = () => {"), bridgeSource.indexOf("  // Watch all class changes"));
const releaseTimers = () => {
  const timers = new Map();
  let next = 0;
  return {
    timers,
    globals: {
      TOOLTIP_RELEASE_MS: 250, tooltipReserve: null, tooltipReleaseTimer: 0,
      setTimeout: (callback, ms) => { timers.set(++next, { callback, ms }); return next; },
      clearTimeout: (id) => timers.delete(id),
    },
    flush: () => {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach(({ callback }) => callback());
    },
  };
};
test("overlay reserves the tooltip's actual width and height and shrinks on close", async () => {
  let tooltip = { getBoundingClientRect: () => ({ right: 610, bottom: 360 }) };
  let fullPanel = false;
  const sizes = [];
  const release = releaseTimers();
  const context = vm.createContext({
    ...release.globals,
    resizeActive: false, lastSizeKey: "", pendingWindowSize: null, isLinux: false,
    PANEL_WIDTH: 1200, PANEL_HEIGHT: 800, PROMO_WIDTH: 600, PROMO_HEIGHT: 400,
    spaceRightBelow: () => ({ w: 900, h: 700 }),
    window: { A2_VIEW: "main", devicePixelRatio: 1.5, javaBridge: {} },
    document: {
      body: { classList: { contains: () => false } },
      querySelector: (selector) => selector === ".meter" ? { offsetWidth: 380, offsetHeight: 200, scrollHeight: 200 }
        : selector === ".hoverDetailsTooltip.isVisible" ? tooltip
        : selector === ".settingsPanel.isOpen" && fullPanel ? {} : null,
    },
    invoke: (command, args) => { sizes.push(args); return Promise.resolve(); },
  });
  vm.runInContext(sizingSource, context);
  await vm.runInContext("updateWindowSize()", context);
  assert.equal(sizes[0].width, 618);
  assert.equal(sizes[0].height, 368);
  assert.equal(sizes[0].scale, 1.5);
  tooltip = null;
  await vm.runInContext("updateWindowSize()", context);
  assert.equal(sizes.length, 1, "shrink waits for the release delay");
  release.flush();
  await tick();
  assert.equal(sizes[1].width, 396);
  assert.equal(sizes[1].height, 210);
  fullPanel = true;
  await vm.runInContext("updateWindowSize()", context);
  assert.equal(sizes[2].width, 1200);
  assert.equal(sizes[2].height, 800);
});


test("on Linux the overlay does not grow for the tooltip", async () => {
  const sizes = [];
  const release = releaseTimers();
  const context = vm.createContext({
    ...release.globals,
    resizeActive: false, lastSizeKey: "", pendingWindowSize: null, isLinux: true,
    PANEL_WIDTH: 1200, PANEL_HEIGHT: 800, PROMO_WIDTH: 600, PROMO_HEIGHT: 400,
    spaceRightBelow: () => ({ w: 900, h: 700 }),
    window: { A2_VIEW: "main", devicePixelRatio: 1, javaBridge: {} },
    document: {
      body: { classList: { contains: () => false } },
      querySelector: (selector) => selector === ".meter" ? { offsetWidth: 380, offsetHeight: 200, scrollHeight: 200 }
        : selector === ".hoverDetailsTooltip.isVisible" ? { getBoundingClientRect: () => ({ right: 610, bottom: 360 }) }
        : null,
    },
    invoke: (command, args) => { sizes.push(args); return Promise.resolve(); },
  });
  vm.runInContext(sizingSource, context);
  await vm.runInContext("updateWindowSize()", context);
  assert.deepEqual([sizes[0].width, sizes[0].height], [396, 210], "the meter's own size");
});


test("hover translations preserve the existing details tooltip text", () => {
  for (const locale of ["en", "ru"]) {
    const dictionary = JSON.parse(readFileSync(new URL(`../src/data/i18n/ui/${locale}.json`, import.meta.url), "utf8"));
    assert.equal(typeof dictionary.details.tooltip, "string");
    const { app } = setup();
    app.i18n = { t: (key, fallback) => key.split(".").reduce((value, part) => value?.[part], dictionary) ?? fallback };
    app.hoverTooltipEl = { style: {}, setAttribute() {}, classList: { add() {} }, offsetWidth: 100, offsetHeight: 100 };
    for (const state of ["loading", "empty", "error"]) {
      Object.getPrototypeOf(app).renderHoverTooltip.call(app, { skills: [], state }, { id: 1 }, {});
      assert.ok(app.hoverTooltipEl.innerHTML.includes(dictionary.details.hoverTooltip[state]));
    }
  }
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const response = (dmg) => ({ skills: [{ code: 11010000, name: 'Skill', dmg, time: 1, actorId: 1 }] });

test('rapid re-entry shares a pending request even when refresh is requested', async () => {
  const request = deferred();
  let calls = 0;
  const { app, rendered } = setup(() => { calls++; return request.promise; });
  app.applyHoverTooltip({ id: 1 }, { forceRefresh: true });
  app.applyHoverTooltip({ id: 1 }, { forceRefresh: true });
  assert.equal(calls, 1);
  request.resolve(response(500));
  await tick();
  assert.equal(rendered.at(-1).skills[0].dmg, 500);
  assert.equal(app.hoverTooltipPendingRowIds.size, 0);
});

function hoverPipeline(mode = 'allTargets') {
  const calls = [];
  const rendered = [];
  let active = 0;
  let peak = 0;
  let visible = false;
  let row;
  const context = vm.createContext({
    console: { log() {} },
    window: { addEventListener() {}, javaBridge: { updateOverlaySize() {} } },
    document: {
      readyState: 'loading', addEventListener() {},
      documentElement: { classList: { toggle() {} } }, body: { classList: { toggle() {} } },
    },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    cachedDpsJson: null, lastSkillDetailsIssue: '',
    invoke(command, args) {
      assert.equal(command, 'get_skill_details');
      peak = Math.max(peak, ++active);
      return new Promise((resolve, reject) => calls.push({
        target: args.targetId,
        resolve(damage) { active--; resolve(response(damage)); },
        reject() { active--; reject(new Error('old target failed')); },
      }));
    },
  });
  vm.runInContext(source, context);
  vm.runInContext(`window.dpsData = { getDpsData: () => cachedDpsJson, ${battleDetailMethod} };`, context);
  const app = vm.runInContext('new DpsApp()', context);
  app.audience = 'everyone';
  app.hoverTooltipEl = { setAttribute() {}, classList: { contains: () => visible, remove() { visible = false; } } };
  app.elList = { querySelector: () => ({}) };
  app.detailsUI = { close() {}, isOpen: () => false };
  app.meterUI = { updateFromRows() {} };
  app.battleTime = { setVisible() {}, update() {} };
  app.buildRowsFromPayload = () => ({ rows: [row], targetName: '', targetMode: mode, battleTimeMs: 1000, targetId: 0, localPlayerId: 1 });
  for (const method of ['applyLocalPlayerIdUpdate', 'updateLocalPlayerIdentity', 'updateConnectionStatusUi', 'updateBossHpBar', 'updateMeterTotalBar', 'logDebug']) app[method] = () => {};
  app.isOutOfCombatState = () => false;
  app.getTargetLabel = () => 'Synthetic';
  app.getRowsSummary = () => ({ listSignature: '' });
  app.renderHoverTooltip = (details, currentRow) => {
    visible = true;
    rendered.push({ rowDamage: currentRow.totalDamage, skillDamage: details.skills?.[0]?.dmg, state: details.state });
  };
  const receiveSnapshot = (targets, damage) => {
    context.cachedDpsJson = JSON.stringify({ targetId: 0, targetMode: mode, detailTargetIds: targets, battleTime: 1000, map: { damage } });
  };
  const setSnapshot = (targets, damage) => {
    row = { id: 1, name: 'Synthetic', dps: damage, totalDamage: damage };
    receiveSnapshot(targets, damage);
    app.fetchDps();
  };
  const enter = () => app.openHoverDetailsRow(row, { clientX: 10, clientY: 10 });
  const leave = () => { app.hoveredDetailsRowId = null; app.hideHoverTooltip(); };
  setSnapshot([100], 100);
  return { app, calls, rendered, setSnapshot, receiveSnapshot, enter, leave, peak: () => peak };
}

for (const mode of ['allTargets', 'trainTargets']) {
  test(`re-entry after a new ${mode} snapshot discards old targets without parallel summaries`, async () => {
    const fixture = hoverPipeline(mode);
    fixture.enter();
    fixture.leave();
    fixture.setSnapshot([200], 200);
    fixture.enter();
    assert.equal(fixture.calls.length, 1, 'new work waits for the old summary');
    fixture.calls[0].resolve(100);
    await tick();
    assert.deepEqual(fixture.calls.map(call => call.target), [100, 200]);
    assert.equal(fixture.app.hoverTooltipCacheByRowId.size, 0);
    assert.ok(!fixture.rendered.some(frame => frame.skillDamage === 100));
    fixture.calls[1].resolve(200);
    await tick();
    assert.deepEqual(fixture.rendered.at(-1), { rowDamage: 200, skillDamage: 200, state: undefined });
    assert.equal(fixture.peak(), 1);
  });
}

test('a new snapshot with the same target ids still gets a fresh summary on re-entry', async () => {
  const fixture = hoverPipeline();
  fixture.enter();
  fixture.leave();
  fixture.setSnapshot([100], 200);
  fixture.enter();
  fixture.calls[0].resolve(100);
  await tick();
  assert.equal(fixture.calls.length, 2);
  assert.ok(!fixture.rendered.some(frame => frame.skillDamage === 100));
  fixture.calls[1].resolve(200);
  await tick();
  assert.equal(fixture.rendered.at(-1).skillDamage, 200);
  assert.equal(fixture.peak(), 1);
});

test('a bridge DPS event invalidates re-entry before the meter processes that snapshot', async () => {
  const fixture = hoverPipeline();
  fixture.enter();
  fixture.leave();
  fixture.receiveSnapshot([200], 200);
  fixture.enter();
  fixture.calls[0].resolve(100);
  await tick();
  assert.deepEqual(fixture.calls.map(call => call.target), [100, 200]);
  assert.ok(!fixture.rendered.some(frame => frame.skillDamage === 100));
  fixture.setSnapshot([200], 200);
  fixture.calls[1].resolve(200);
  await tick();
  assert.equal(fixture.rendered.at(-1).rowDamage, 200);
  assert.equal(fixture.rendered.at(-1).skillDamage, 200);
});

test('a target set change refreshes stationary hover after its old request finishes', async () => {
  const fixture = hoverPipeline();
  fixture.enter();
  fixture.setSnapshot([200], 200);
  fixture.calls[0].resolve(100);
  await tick();
  assert.ok(!fixture.rendered.some(frame => frame.skillDamage === 100));
  assert.equal(fixture.calls[1].target, 200);
  fixture.calls[1].resolve(200);
  await tick();
  assert.equal(fixture.rendered.at(-1).skillDamage, 200);
});

test('steady damage updates let a slow same-target summary finish with current row totals', async () => {
  const fixture = hoverPipeline();
  fixture.enter();
  for (let damage = 200; damage <= 500; damage += 100) fixture.setSnapshot([100], damage);
  fixture.calls[0].resolve(500);
  await tick();
  assert.equal(fixture.calls.length, 1, 'updates do not continuously cancel a slow request');
  assert.equal(fixture.rendered.at(-1).rowDamage, 500);
  assert.equal(fixture.rendered.at(-1).skillDamage, 500);
  fixture.leave();
  fixture.enter();
  assert.equal(fixture.calls.length, 2, 'an old-generation cache does not suppress a fresh re-entry');
  fixture.calls[1].resolve(500);
  await tick();
});

test('a failed old-generation request does not replace the new hover with an error', async () => {
  const fixture = hoverPipeline();
  fixture.enter();
  fixture.leave();
  fixture.setSnapshot([200], 200);
  fixture.enter();
  fixture.calls[0].reject();
  await tick();
  assert.ok(!fixture.rendered.some(frame => frame.state === 'error'));
  assert.equal(fixture.calls[1].target, 200);
  fixture.calls[1].resolve(200);
  await tick();
  assert.equal(fixture.rendered.at(-1).skillDamage, 200);
  assert.equal(fixture.app.hoverTooltipPendingRowIds.size, 0);
});

test('cached data stays visible during refresh instead of flashing loading', async () => {
  const request = deferred();
  const { app, rendered } = setup(() => request.promise);
  app.hoverTooltipCacheByRowId.set(1, response(400));
  app.applyHoverTooltip({ id: 1 }, { forceRefresh: true });
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].skills[0].dmg, 400);
  request.resolve(response(500));
  await tick();
  assert.equal(rendered.at(-1).skills[0].dmg, 500);
});

test('returning to a cached row does not request the same snapshot again', () => {
  const { app, rendered } = setup(() => assert.fail('unexpected request'));
  app.hoverTooltipCacheByRowId.set(1, response(400));
  app.hoveredDetailsRowId = null;
  app.pinnedDetailsRowId = null;
  app.shouldSuppressRowInteractions = () => false;
  app.openHoverDetailsRow({ id: 1 });
  assert.equal(rendered.at(-1).skills[0].dmg, 400);
});

test('closing the tooltip cancels motion and a late response cannot reopen it', async () => {
  const request = deferred();
  const { app, rendered, frames, flushFrame } = setup(() => request.promise);
  let visible = true;
  let hidden;
  app.hoverTooltipEl = {
    classList: { contains: () => visible, remove: () => { visible = false; } },
    setAttribute: (_, value) => { hidden = value; },
  };
  app.positionHoverTooltip = () => assert.fail('closed tooltip repositioned');
  app.applyHoverTooltip({ id: 1 });
  app.scheduleHoverTooltipPosition();
  assert.equal(frames.size, 1);
  app.hideHoverTooltip();
  assert.equal(frames.size, 0);
  assert.equal(hidden, 'true');
  flushFrame();
  request.resolve(response(500));
  await tick();
  assert.equal(rendered.length, 1);
  assert.equal(app.hoverTooltipCacheByRowId.get(1).skills[0].dmg, 500);
});

test('switching players cannot display a late answer for the previous player', async () => {
  const request = deferred();
  const { app, rendered } = setup(() => request.promise);
  app.applyHoverTooltip({ id: 1 });
  app.hoveredDetailsRowId = 2;
  request.resolve(response(500));
  await tick();
  assert.equal(rendered.length, 1);
  assert.equal(app.hoverTooltipCacheByRowId.get(1).skills[0].dmg, 500);
});

test('a late summary cannot render or cache a row hidden by an audience change', async () => {
  const request = deferred();
  const { app, rendered } = setup(() => request.promise);
  app.applyHoverTooltip({ id: 1 });
  app.setAudience('self');
  assert.equal(app.latestRowsById.has('1'), false);
  request.resolve(response(500));
  await tick();
  assert.equal(rendered.length, 1, 'the pending row never replaces its loading state after leaving the view');
  assert.equal(app.hoverTooltipCacheByRowId.size, 0);
  assert.equal(app.hoverTooltipPendingRowIds.size, 0);
});

test('invalidating a fight rejects old answers without clearing the new pending request', async () => {
  const oldRequest = deferred();
  const newRequest = deferred();
  let calls = 0;
  const { app, rendered } = setup(() => (++calls === 1 ? oldRequest : newRequest).promise);
  app.applyHoverTooltip({ id: 1 });
  app.invalidateHoverTooltip();
  app.hoveredDetailsRowId = 1;
  app.hoverTooltipDismissed = false;
  app.applyHoverTooltip({ id: 1 });
  oldRequest.resolve(response(100));
  await tick();
  assert.equal(app.hoverTooltipCacheByRowId.size, 0);
  assert.ok(app.hoverTooltipPendingRowIds.has(1));
  assert.equal(rendered.length, 2);
  newRequest.resolve(response(900));
  await tick();
  assert.equal(rendered.at(-1).skills[0].dmg, 900);
  assert.equal(app.hoverTooltipPendingRowIds.size, 0);
});

test('native travel area stays fixed during motion, is screen-clamped and shrinks on close', async () => {
  let bounds = { right: 610, bottom: 360, width: 240, height: 180 };
  let room = { w: 900, h: 700 };
  const sizes = [];
  const release = releaseTimers();
  const context = vm.createContext({
    ...release.globals,
    resizeActive: false, lastSizeKey: '', pendingWindowSize: null, isLinux: false,
    PANEL_WIDTH: 1200, PANEL_HEIGHT: 800, PROMO_WIDTH: 600, PROMO_HEIGHT: 400,
    spaceRightBelow: () => room,
    window: { A2_VIEW: 'main', devicePixelRatio: 1.5, javaBridge: {} },
    document: {
      body: { classList: { contains: () => false } },
      querySelector: (selector) => selector === '.meter' ? { offsetWidth: 380, offsetHeight: 300, scrollHeight: 300 }
        : selector === '.hoverDetailsTooltip.isVisible' ? (bounds && { getBoundingClientRect: () => bounds })
        : selector === '.list:not(.barPreviewList)' ? { getBoundingClientRect: () => ({ right: 380, bottom: 260 }) } : null,
    },
    invoke: (command, args) => { sizes.push(args); return Promise.resolve(); },
  });
  vm.runInContext(sizingSource, context);
  await vm.runInContext('updateWindowSize()', context);
  assert.equal(sizes[0].width, 640);
  assert.equal(sizes[0].height, 460);
  bounds = { ...bounds, right: 490, bottom: 320 };
  await vm.runInContext('updateWindowSize()', context);
  assert.equal(sizes.length, 1);
  room = { w: 500, h: 400 };
  await vm.runInContext('updateWindowSize()', context);
  assert.equal(sizes[1].width, 500);
  assert.equal(sizes[1].height, 400);
  bounds = null;
  await vm.runInContext('updateWindowSize()', context);
  release.flush();
  await tick();
  assert.equal(sizes[2].width, 396);
  assert.equal(sizes[2].height, 310);
});

test('stationary hover schedules no frames and repeated coordinates do not wake rendering', () => {
  const { app, frames, flushFrame } = setup();
  app.pinnedDetailsRowId = null;
  app.shouldSuppressRowInteractions = () => false;
  app.hoverMousePos = { x: 100, y: 80 };
  app.hoverTooltipEl = { classList: { contains: () => true } };
  let positions = 0;
  app.positionHoverTooltip = () => positions++;
  for (let i = 0; i < 1000; i++) app.openHoverDetailsRow({ id: 1 }, { clientX: 100, clientY: 80 });
  assert.equal(frames.size, 0);
  app.openHoverDetailsRow({ id: 1 }, { clientX: 101, clientY: 80 });
  flushFrame();
  assert.equal(positions, 1);
  assert.equal(frames.size, 0, 'no self-rescheduling animation loop');
});

test('hover requests summary data while full details retain the original contract', async () => {
  const { api, calls } = bridge({ targetId: 42 }, { 42: response(500) });
  const { app } = setup((id, options) => api.getBattleDetail(id, options));
  app.applyHoverTooltip({ id: 1 });
  await tick();
  assert.equal(calls[0].summaryOnly, true);
  const full = await api.getBattleDetail(1);
  assert.equal(calls[1].summaryOnly, false);
  assert.equal(typeof full, 'string');
  const summary = await api.getBattleDetail(1, { summaryOnly: true });
  assert.equal(typeof summary, 'object', 'avoid a stringify/parse round trip');
  assert.equal(summary.skills[0].dmg, 500);
});

test('summary selects the global top five after merging targets, with DOT distinct', async () => {
  const skills = [1, 2, 3, 4, 5, 6].map((n) => ({ code: 11000000 + n * 10000, actorId: 1, name: `Skill ${n}`, dmg: n * 100 }));
  const { api } = bridge({ detailTargetIds: [42, 43] }, {
    42: { skills }, 43: { skills: [{ ...skills[0], dmg: 1000 }, { ...skills[0], dmg: 900, isDot: true }] },
  });
  const { app } = setup((id, options) => api.getBattleDetail(id, options));
  const summary = await app.getDetails({ id: 1 }, { summaryOnly: true });
  assert.deepEqual(Array.from(summary.skills, (s) => s.dmg), [1100, 900, 600, 500, 400]);
  assert.equal(summary.skills[1].isDot, true);
});

test('many selected targets use bounded IPC concurrency without losing any damage', async () => {
  let active = 0;
  let peak = 0;
  let completed = 0;
  const context = vm.createContext({
    cachedDpsJson: JSON.stringify({ detailTargetIds: Array.from({ length: 64 }, (_, i) => i + 1) }),
    lastSkillDetailsIssue: '', window: {},
    invoke: async (command, args) => {
      assert.equal(command, 'get_skill_details');
      peak = Math.max(peak, ++active);
      await tick();
      active--;
      completed++;
      return { totalTargetDamage: args.targetId, skills: [{ actorId: 1, code: 11010000, dmg: args.targetId }] };
    },
  });
  const api = vm.runInContext(`({${battleDetailMethod}})`, context);
  const result = await api.getBattleDetail(1, { summaryOnly: true });
  assert.equal(completed, 64);
  assert.equal(peak, 4);
  assert.equal(result.totalTargetDamage, 2080);
  assert.equal(result.skills[0].dmg, 2080);
});

test('a failed multi-target request stops scheduling work for its discarded result', async () => {
  let calls = 0;
  const context = vm.createContext({
    cachedDpsJson: JSON.stringify({ detailTargetIds: Array.from({ length: 100 }, (_, i) => i + 1) }),
    lastSkillDetailsIssue: '', window: {},
    invoke: async (_, args) => {
      calls++;
      if (args.targetId === 1) throw new Error('details failed');
      await tick();
      return { skills: [] };
    },
  });
  const api = vm.runInContext(`({${battleDetailMethod}})`, context);
  await assert.rejects(api.getBattleDetail(1), /details failed/);
  await tick();
  await tick();
  assert.equal(calls, 4);
});

const detailsSource = readFileSync(new URL("../public/src/js/details.js", import.meta.url), "utf8");
const detailsLoadSource = detailsSource.slice(detailsSource.indexOf("  // A synthetic null row"),
  detailsSource.indexOf("  const render = (details, row) => {"));

function detailsView(getDetails, targetCount = 20) {
  const targets = Array.from({ length: targetCount }, (_, i) => ({ targetId: i + 1, totalDamage: 10 }));
  const rendered = [];
  const logs = [];
  const context = vm.createContext({
    getDetails, rendered, logs,
    window: { javaBridge: { logToDebug: (s) => logs.push(s) } },
    openSeq: 1, lastRow: { id: 7 }, lastDetails: { old: true }, lastUnfilteredDetails: null,
    activeCompactMode: false, detailsContext: {}, detailsTargets: targets,
    selectedTargetId: null, selectedAttackerIds: [7], COMPACT_MAX_SKILLS: 5,
    getSelectableTargets: () => targets,
    getTargetById: (id) => targets.find((t) => t.targetId === id),
    buildCombinedDetails: (list, total) => ({ list, total }),
    render: (details) => rendered.push(details),
    statSlots: [{ valueEl: { textContent: "1" } }],
    skillSlots: [{ rowEl: { style: {} }, rowFillEl: { style: {} } }],
  });
  vm.runInContext(detailsLoadSource, context);
  return { context, rendered, logs, refresh: (seq) => vm.runInContext(`refreshDetailsView(${seq})`, context) };
}

const flushAll = async () => { for (let i = 0; i < 50; i++) await tick(); };

test("details for many targets share four request slots across player and All loads", async () => {
  let active = 0;
  let peak = 0;
  const calls = [];
  const { context, rendered, refresh } = detailsView(async (_, options) => {
    calls.push(options);
    peak = Math.max(peak, ++active);
    await tick();
    active--;
    return { targetId: options.targetId, attackers: options.attackerIds };
  });
  await refresh(1);
  assert.equal(peak, 4);
  assert.equal(calls.length, 40, "20 filtered and 20 All requests");
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].list.length, 20);
  assert.ok(rendered[0].list.every((details) => details.attackers?.[0] === 7));
  assert.equal(context.lastUnfilteredDetails.list.length, 20);
  assert.ok(context.lastUnfilteredDetails.list.every((details) => details.attackers === null));
});

test("a failed target shows the load error instead of a partial sum", async () => {
  const calls = new Map();
  const { context, rendered, logs, refresh } = detailsView(async (_, options) => {
    calls.set(options.targetId, (calls.get(options.targetId) || 0) + 1);
    await tick();
    if (options.targetId === 1) throw new Error("details failed");
    return { targetId: options.targetId };
  });
  await refresh(1);
  await flushAll();
  assert.equal(rendered.length, 0);
  assert.equal(context.lastDetails, null);
  assert.equal(context.statSlots[0].valueEl.textContent, "-");
  assert.equal(context.skillSlots[0].rowEl.style.display, "none");
  assert.match(logs[0], /details failed/);
  assert.equal(calls.get(1), 1, "a failed request is not repeated");
  const total = Array.from(calls.values()).reduce((sum, n) => sum + n, 0);
  assert.ok(total < 40, "queued requests of a failed load are dropped");
});

test("a superseded load stops scheduling requests and keeps the newer view", async () => {
  let calls = 0;
  const { context, rendered, logs, refresh } = detailsView(async () => {
    calls++;
    await tick();
    return {};
  });
  const pending = refresh(1);
  context.openSeq = 2;
  await pending;
  await flushAll();
  assert.equal(rendered.length, 0);
  assert.equal(logs.length, 0);
  assert.equal(context.statSlots[0].valueEl.textContent, "1");
  assert.ok(calls <= 4);
});

test("an IPC failure of target details is an error, not an empty fight", async () => {
  const { app, window } = setup();
  window.dpsData.getTargetDetails = async (targetId) => (targetId === 1 ? null : "null");
  await assert.rejects(app.getDetails({ id: 7 }, { targetId: 1, attackerIds: [7] }), /target 1/);
  const empty = await app.getDetails({ id: 7 }, { targetId: 2, attackerIds: [7] });
  assert.equal(empty.skills.length, 0);
});

test("moving between rows keeps the native window size and leaving the meter shrinks it", async () => {
  let bounds = { right: 610, bottom: 360, width: 240, height: 180 };
  const sizes = [];
  const release = releaseTimers();
  const context = vm.createContext({
    ...release.globals,
    resizeActive: false, lastSizeKey: '', pendingWindowSize: null, isLinux: false,
    PANEL_WIDTH: 1200, PANEL_HEIGHT: 800, PROMO_WIDTH: 600, PROMO_HEIGHT: 400,
    spaceRightBelow: () => ({ w: 1900, h: 1000 }),
    window: { A2_VIEW: 'main', devicePixelRatio: 1, javaBridge: {} },
    document: {
      body: { classList: { contains: () => false } },
      querySelector: (selector) => selector === '.meter' ? { offsetWidth: 380, offsetHeight: 300, scrollHeight: 300 }
        : selector === '.hoverDetailsTooltip.isVisible' ? (bounds && { getBoundingClientRect: () => bounds })
        : selector === '.list:not(.barPreviewList)' ? { getBoundingClientRect: () => ({ right: 380, bottom: 260 }) } : null,
    },
    invoke: (command, args) => { sizes.push(args); return Promise.resolve(); },
  });
  vm.runInContext(sizingSource, context);
  const update = () => vm.runInContext('updateWindowSize()', context);
  await update();
  assert.equal(sizes.length, 1);
  for (const width of [200, 300, 240]) {
    bounds = null;
    await update();
    await update();
    bounds = { right: 610, bottom: 360, width, height: 150 };
    await update();
  }
  assert.equal(sizes.length, 2, "a wider row grows the area once; nothing shrinks between rows");
  assert.equal(sizes[1].width, 700);
  assert.equal(release.timers.size, 0, "showing the tooltip again cancels the pending shrink");
  bounds = null;
  await update();
  assert.equal(sizes.length, 2);
  assert.equal(release.timers.size, 1);
  assert.equal([...release.timers.values()][0].ms, 250);
  release.flush();
  await tick();
  assert.deepEqual({ width: sizes[2].width, height: sizes[2].height }, { width: 396, height: 310 });
  await update();
  assert.equal(sizes.length, 3, "no reserved area remains after the tooltip is gone");
});

test("a target change refreshes the visible tooltip in place", async () => {
  const request = deferred();
  const { app, rendered, window } = setup(() => request.promise);
  window.javaBridge.updateOverlaySize = () => assert.fail("target change must not resize");
  app.hoverTooltipDismissed = false;
  app.hoverTooltipEl = { classList: { contains: () => true, remove: () => assert.fail("tooltip hidden") } };
  app.hoverTooltipCacheByRowId.set(1, response(400));
  app.hoverTooltipCacheByRowId.set(2, response(300));
  const oldSeq = {};
  app.hoverTooltipRequestSeqByRowId.set(1, oldSeq);
  app.hoverTooltipPendingRowIds.add(1);
  app.refreshHoverTooltipForTarget([{ id: "1", name: "Me" }, { id: "2" }]);
  assert.equal(app.hoveredDetailsRowId, 1);
  assert.equal(rendered.length, 0, "old skills stay on screen, no loading flash");
  assert.equal(app.hoverTooltipCacheByRowId.size, 0, "old skills are not cached for the new target");
  assert.notEqual(app.hoverTooltipRequestSeqByRowId.get(1), oldSeq);
  request.resolve(response(900));
  await tick();
  assert.equal(rendered.at(-1).skills[0].dmg, 900);
  // Runs after the new rows are in the DOM, also when a refresh is pending.
  assert.match(source, /this\.meterUI\.updateFromRows\(rowsToRender\);\s+if \(targetChanged\) this\.refreshHoverTooltipForTarget\(rowsToRender\);/);
  assert.equal((source.match(/refreshHoverTooltipForTarget\(/g) || []).length, 2);
});

test("a target change hides the tooltip when its row left the rendered list", () => {
  const { app, window } = setup(() => assert.fail("no request for a row that is not rendered"));
  let visible = true;
  window.javaBridge.updateOverlaySize = () => {};
  app.hoverTooltipDismissed = false;
  app.elList = { querySelector: () => null };
  app.hoverTooltipEl = { classList: { contains: () => visible, remove: () => { visible = false; } }, setAttribute() {} };
  app.refreshHoverTooltipForTarget([{ id: "1" }]);
  assert.equal(visible, false);
  assert.equal(app.hoveredDetailsRowId, null);
});

test("sweeping across rows keeps one summary in flight and then asks only for the last row", async () => {
  const requests = [];
  const { app, rendered } = setup((query) => {
    const request = deferred();
    requests.push({ query, ...request });
    return request.promise;
  });
  for (const id of [1, 2, 3, 4]) {
    app.hoveredDetailsRowId = id;
    app.applyHoverTooltip({ id });
  }
  assert.equal(requests.length, 1);
  assert.equal(rendered.filter((item) => item.state === "loading").length, 4);
  requests[0].resolve(response(100));
  await tick();
  await tick();
  assert.equal(requests.length, 2);
  requests[1].resolve(response(400));
  await tick();
  await tick();
  assert.equal(requests.length, 2, "rows 2 and 3 were skipped");
  assert.equal(rendered.at(-1).skills[0].dmg, 400);
  assert.equal(app.hoverTooltipInFlight, false);
});

test("hiding an already hidden tooltip does not resize the window", () => {
  const { app, window } = setup(() => assert.fail("unexpected request"));
  window.javaBridge.updateOverlaySize = () => assert.fail("resized while hidden");
  app.hoverTooltipEl = { classList: { contains: () => false } };
  app.hideHoverTooltip();
});

test("a target change hides the tooltip only when its row is gone", () => {
  const { app, window } = setup(() => assert.fail("no request for a missing row"));
  let visible = true;
  window.javaBridge.updateOverlaySize = () => {};
  app.hoverTooltipDismissed = false;
  app.hoverTooltipEl = { classList: { contains: () => visible, remove: () => { visible = false; } }, setAttribute() {} };
  app.refreshHoverTooltipForTarget([{ id: "2" }]);
  assert.equal(visible, false);
  assert.equal(app.hoveredDetailsRowId, null);
  const idle = setup(() => assert.fail("no request without a visible tooltip"));
  idle.app.hoverTooltipCacheByRowId.set(1, response(400));
  idle.app.refreshHoverTooltipForTarget([{ id: "1" }]);
  assert.equal(idle.app.hoverTooltipCacheByRowId.size, 0);
});
