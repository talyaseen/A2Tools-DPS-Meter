import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/src/js/core.js', import.meta.url), 'utf8');

function fixture(initial = {}) {
  const stored = new Map(Object.entries(initial));
  const writes = [];
  const window = { addEventListener() {}, A2_VIEW: 'main' };
  const document = { readyState: 'loading', addEventListener() {}, querySelector() { return null; } };
  const context = vm.createContext({ window, document, console, requestAnimationFrame: callback => callback() });
  vm.runInContext(source, context);
  const app = window.dpsApp;
  app.USER_NAME = 'Mine';
  app.localPlayerId = 1;
  app.audienceKnown = true;
  app.safeGetSetting = key => stored.get(key) ?? null;
  app.safeSetSetting = (key, value) => { stored.set(key, String(value)); writes.push([key, String(value)]); };
  app.logDebug = () => {};
  app.closeOrphanTooltip = () => {};
  app.updateConnectionStatusUi = () => {};
  app.audience = app.readAudience();
  return { app, window, stored, writes, context };
}

const row = (id, totalDamage, flags = {}) => ({
  id: String(id), name: id === 1 ? 'Mine' : `Player ${id}`, job: 'Assassin',
  totalDamage, dps: totalDamage / 10, damageContribution: 7,
  isUser: id === 1, isLocalPlayer: id === 1, isPartyMember: id === 1,
  ...flags,
});
const ids = rows => Array.from(rows, r => r.id);

test('audience defaults to the group and migrates only an actual legacy choice', () => {
  for (const [stored, expected] of [
    [{}, 'party'],
    [{ 'dpsMeter.onlyShowUser': 'true' }, 'self'],
    [{ 'dpsMeter.onlyShowUser': 'false' }, 'everyone'],
    [{ 'dpsMeter.onlyShowUser': 'yes' }, 'party'],
    [{ 'dpsMeter.audience': 'party', 'dpsMeter.onlyShowUser': 'false' }, 'party'],
    [{ 'dpsMeter.audience': 'self', 'dpsMeter.onlyShowUser': 'false' }, 'self'],
    [{ 'dpsMeter.audience': 'everyone', 'dpsMeter.onlyShowUser': 'true' }, 'everyone'],
    [{ 'dpsMeter.audience': 'invalid', 'dpsMeter.onlyShowUser': 'false' }, 'party'],
    [{ 'dpsMeter.audience': '', 'dpsMeter.onlyShowUser': 'false' }, 'party'],
  ]) assert.equal(fixture(stored).app.audience, expected, JSON.stringify(stored));
});

test('each explicit choice persists through the shared settings store and reopening', () => {
  for (const value of ['everyone', 'party', 'self']) {
    const f = fixture({ 'dpsMeter.audience': value === 'party' ? 'everyone' : 'party' });
    let rendered = 0;
    f.app.renderCurrentRows = () => { rendered++; };
    f.app.setAudience(value, { persist: true });
    assert.equal(f.app.audience, value);
    assert.equal(f.stored.get('dpsMeter.audience'), value);
    assert.equal(rendered, 1);
    assert.equal(fixture(Object.fromEntries(f.stored)).app.audience, value);
    assert.deepEqual(f.writes, [['dpsMeter.audience', value]]);
  }
});

test('an unknown identity never widens a restricted choice to everyone', () => {
  const f = fixture();
  f.app.audienceKnown = false;
  const rows = [row(1, 100), row(2, 900, { isPartyMember: true })];
  for (const choice of ['party', 'self']) {
    f.app.audience = choice;
    assert.deepEqual(ids(f.app.filterRowsByAudience(rows)), []);
  }
  f.app.audience = 'everyone';
  assert.deepEqual(ids(f.app.filterRowsByAudience(rows)), ['1', '2']);
});

test('native membership and local identity take priority over a matching nickname or id', () => {
  const f = fixture();
  const result = f.app.buildRowsFromPayload(JSON.stringify({ audienceKnown: true, localPlayerId: 1, map: {
    1: { nickname: 'Mine', job: 'Assassin', dps: 100, amount: 1000, isLocalPlayer: false, isPartyMember: false },
    2: { nickname: 'Actual self', job: 'Assassin', dps: 10, amount: 100, isLocalPlayer: true, isPartyMember: true },
    3: { nickname: 'Group', job: 'Assassin', dps: 20, amount: 200, isLocalPlayer: false, isPartyMember: true },
  } }));
  assert.equal(result.audienceKnown, true);
  assert.equal(result.rows.find(r => r.id === '1').isUser, false);
  assert.equal(result.rows.find(r => r.id === '2').isUser, true);
  assert.equal(result.rows.find(r => r.id === '3').isPartyMember, true);
  f.app.audience = 'self';
  assert.deepEqual(ids(f.app.filterRowsByAudience(result.rows)), ['2']);
});

test('group and self selection exclude the aggregate Others row and preserve canonical data', () => {
  const f = fixture();
  const original = [row(1, 100), row(2, 300, { isPartyMember: true }), row(3, 1000),
    row(4, 600, { isOthers: true, isPartyMember: true })];
  const before = JSON.stringify(original);
  f.app.audience = 'party';
  const group = f.app.filterRowsByAudience(original);
  assert.deepEqual(ids(group), ['1', '2']);
  assert.deepEqual(Array.from(group, r => r.damageContribution), [25, 75]);
  assert.equal(group.reduce((total, r) => total + r.totalDamage, 0), 400);
  assert.equal(group.reduce((total, r) => total + r.dps, 0), 40);
  assert.notEqual(group[0], original[0], 'display percentages are calculated on copies');
  f.app.audience = 'self';
  assert.deepEqual(ids(f.app.filterRowsByAudience(original)), ['1']);
  assert.equal(f.app.filterRowsByAudience(original)[0].damageContribution, 100);
  f.app.audience = 'everyone';
  assert.deepEqual(ids(f.app.filterRowsByAudience(original)), ['1', '2', '3', '4']);
  assert.equal(JSON.stringify(original), before, 'switching display scope never edits the canonical snapshot');
});

test('Everyone remains an explicit choice at training dummies', () => {
  const f = fixture({ 'dpsMeter.audience': 'everyone' });
  f.app.lastTargetMode = 'trainTargets';
  f.app.lastSnapshot = [row(1, 100), row(2, 900)];
  let rendered;
  f.app.updateMeterTotalBar = () => {};
  f.app.meterUI = { updateFromRows(rows) { rendered = ids(rows); } };
  f.app.renderCurrentRows();
  assert.deepEqual(rendered, ['1', '2']);
});

test('the audience is selected before totals and the existing player limit', () => {
  const f = fixture();
  f.app.playerLimit = 2;
  f.app.lastSnapshot = [row(9, 10000), row(1, 100), row(2, 300, { isPartyMember: true }),
    row(3, 200, { isPartyMember: true }), row(4, 400, { isPartyMember: true })];
  let total;
  let presented;
  f.app.updateMeterTotalBar = rows => { total = rows.reduce((n, r) => n + r.totalDamage, 0); };
  f.app.meterUI = { updateFromRows(rows) {
    assert.deepEqual(ids(rows), ['1', '2', '3', '4'], 'the renderer receives all group rows before applying its row cap');
    presented = [...rows].sort((a, b) => b.totalDamage - a.totalDamage).slice(0, f.app.playerLimit);
  } };
  f.app.renderCurrentRows();
  assert.equal(total, 1000, 'the total covers the selected audience even when the row limit is smaller');
  assert.deepEqual(ids(presented), ['4', '2']);
  assert.equal(f.app.playerLimit, 2);
  assert.equal(f.app.lastSnapshot.length, 5);
});

test('cached rows follow the current party classification when membership changes', () => {
  const f = fixture();
  const snapshot = [row(1, 100), row(2, 300, { isPartyMember: true }), row(3, 200)];
  const incoming = [row(1, 0), row(2, 0, { isPartyMember: false }), row(3, 0, { isPartyMember: true })];
  const refreshed = f.app.updateSnapshotNicknameForUser(incoming, snapshot);
  assert.deepEqual(ids(f.app.filterRowsByAudience(refreshed)), ['1', '3']);
  assert.equal(refreshed.find(r => r.id === '3').totalDamage, 200, 'refreshing metadata keeps recorded totals');
  assert.equal(snapshot.find(r => r.id === '2').isPartyMember, true, 'the retained source snapshot is not mutated');
});

test('zero-damage group rows have finite zero contributions', () => {
  const f = fixture();
  const shown = f.app.filterRowsByAudience([row(1, 0), row(2, 0, { isPartyMember: true }), row(3, 1000)]);
  assert.deepEqual(ids(shown), ['1', '2']);
  assert.ok(shown.every(r => r.damageContribution === 0));
});

test('the real meter keeps its player cap and own-row retention after audience filtering', () => {
  const f = fixture();
  class Element {
    constructor() {
      this.children = [];
      this.dataset = {};
      this.className = '';
      this.style = { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } };
      this.classList = {
        contains: name => this.className.split(' ').includes(name),
        add: (...names) => { this.className = [...new Set([...this.className.split(' '), ...names])].filter(Boolean).join(' '); },
        remove: (...names) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' '); },
        toggle: (name, on) => { const next = on ?? !this.classList.contains(name); this.classList[next ? 'add' : 'remove'](name); },
      };
    }
    addEventListener() {}
    setAttribute(name, value) { this[name] = value; }
    removeAttribute(name) { delete this[name]; }
    appendChild(child) {
      child.remove();
      child.parentNode = this;
      this.children.push(child);
      return child;
    }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
    replaceChildren(...children) { this.children = []; for (const child of children) this.appendChild(child); }
    querySelector(selector) {
      for (const child of this.children) {
        if (child.classList.contains(selector.slice(1))) return child;
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
      return null;
    }
  }
  const list = new Element();
  const frames = [];
  f.context.document.createElement = () => new Element();
  f.context.document.documentElement = { dataset: {} };
  f.context.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  f.context.cancelAnimationFrame = () => {};
  vm.runInContext(readFileSync(new URL('../public/src/js/meter.js', import.meta.url), 'utf8'), f.context);
  const createMeterUI = vm.runInContext('createMeterUI', f.context);
  f.app.playerLimit = 2;
  f.app.lastSnapshot = [row(9, 10000), row(1, 100), row(2, 300, { isPartyMember: true }),
    row(3, 200, { isPartyMember: true }), row(4, 400, { isPartyMember: true })];
  f.app.updateMeterTotalBar = () => {};
  f.app.meterUI = createMeterUI({ elList: list, dpsFormatter: new Intl.NumberFormat('en-US'),
    getMetric: r => ({ value: r.dps, text: String(r.dps) }), getSortDirection: () => 'desc',
    getUserName: () => 'Mine', getPlayerLimit: () => f.app.playerLimit, getPartyStat: () => 'off',
    getPinUserToTop: () => false });
  f.app.renderCurrentRows();
  frames.splice(0).forEach(callback => callback());
  const visible = list.children.filter(child => child.style.display !== 'none');
  assert.deepEqual(visible.map(child => child.dataset.rowId), ['4', '2', '1'], 'the top two group rows plus the existing own-row exception remain');
  assert.equal(f.app.meterUI.getRowById('9'), null, 'an outsider does not occupy a displayed slot');
  assert.equal(visible[0].querySelector('.fill').style.width, '100.00%');
  assert.equal(visible[1].querySelector('.fill').style.width, '75.00%');
  assert.equal(visible[0].querySelector('.dpsContribution').textContent, '40.0%');
  assert.equal(visible[1].querySelector('.dpsContribution').textContent, '30.0%');
  assert.equal(visible[2].querySelector('.dpsContribution').textContent, '10.0%');
  assert.equal(f.app.playerLimit, 2);
});

const detailsContext = () => ({ audienceKnown: true, actors: [
  { actorId: 1, nickname: 'Mine', isLocalPlayer: true, isPartyMember: true },
  { actorId: 2, nickname: 'Group', isLocalPlayer: false, isPartyMember: true },
  { actorId: 3, nickname: 'Stranger', isLocalPlayer: false, isPartyMember: false },
], targets: [{ targetId: 77, totalDamage: 1000, actorDamage: { 1: 100, 2: 300, 3: 600 } }] });
const detailSkills = () => ({ battleTime: 10000, totalTargetDamage: 1000, skills: [
  { actorId: 1, code: '11', name: 'My skill', dmg: 100, time: 1 },
  { actorId: 2, code: '22', name: 'Group skill', dmg: 300, time: 1 },
  { actorId: 3, code: '33', name: 'Stranger skill', dmg: 600, time: 1 },
], healSkills: [
  { actorId: 2, code: '23', name: 'Group heal', dmg: 50, time: 1 },
  { actorId: 3, code: '34', name: 'Stranger heal', dmg: 900, time: 1 },
], deaths: [{ actorId: 2, atMs: 1 }, { actorId: 3, atMs: 2 }] });

test('live Details context uses the same audience without mutating the canonical context', () => {
  const f = fixture();
  const context = detailsContext();
  const before = JSON.stringify(context);
  const party = f.app.filterDetailsContext(context);
  assert.deepEqual(Array.from(party.actors, actor => actor.actorId), [1, 2]);
  assert.deepEqual(Object.keys(party.targets[0].actorDamage), ['1', '2']);
  assert.equal(party.targets[0].totalDamage, 400);
  f.app.audience = 'self';
  const self = f.app.filterDetailsContext(context);
  assert.deepEqual(Array.from(self.actors, actor => actor.actorId), [1]);
  assert.equal(self.targets[0].totalDamage, 100);
  f.app.audience = 'everyone';
  assert.equal(f.app.filterDetailsContext(context).targets[0].totalDamage, 1000);
  assert.equal(JSON.stringify(context), before);
});

test('restricted Details waits when a cached context belongs to an older party or character', () => {
  for (const [current, expected] of [
    [{ partyGeneration: 2, localPlayerId: 1, audienceKnown: true }, []],
    [{ partyGeneration: 1, localPlayerId: 9, audienceKnown: true }, []],
    [{ partyGeneration: 1, localPlayerId: 1, audienceKnown: false }, []],
    [{ partyGeneration: 1, localPlayerId: 1, audienceKnown: true }, [1, 2]],
  ]) {
    const f = fixture();
    f.window.dpsData = { getDpsData: () => JSON.stringify(current) };
    const context = { ...detailsContext(), partyGeneration: 1, localPlayerId: 1 };
    const filtered = f.app.filterDetailsContext(context);
    assert.deepEqual(Array.from(filtered.actors, actor => actor.actorId), expected);
    assert.equal(filtered.targets[0].totalDamage, expected.length ? 400 : 0);
    assert.deepEqual(Object.keys(filtered.targets[0].actorDamage), expected.map(String));
  }
});

test('aggregate live Details clips requested actors and returned damage, heals, and deaths', async () => {
  const f = fixture();
  let request;
  f.window.dpsData = {
    getDetailsContext: () => detailsContext(),
    getTargetDetails: async (target, json) => { request = [target, JSON.parse(json)]; return detailSkills(); },
  };
  const details = await f.app.getDetails({ id: 0 }, { targetId: 77 });
  assert.deepEqual(request, [77, [1, 2]]);
  assert.equal(details.totalDmg, 400);
  assert.equal(details.totalHeal, 50);
  assert.deepEqual(Array.from(details.skills, skill => skill.actorId).sort(), [1, 2]);
  assert.deepEqual(Array.from(details.deaths, death => death.actorId), [2]);
  assert.equal(details.contributionPct, 100);
});

test('a selected row remains that row while its Details share uses the selected audience total', async () => {
  const f = fixture();
  let request;
  f.window.dpsData = {
    getDetailsContext: () => detailsContext(),
    getTargetDetails: async (target, json) => { request = [target, JSON.parse(json)]; return detailSkills(); },
  };
  const details = await f.app.getDetails({ id: 2 }, { targetId: 77, attackerIds: [2] });
  assert.deepEqual(request, [77, [2]]);
  assert.equal(details.totalDmg, 300);
  assert.equal(details.contributionPct, 75);
  assert.deepEqual(Array.from(details.skills, skill => skill.actorId), [2]);
});

test('unknown live Details identity yields an empty result without an all-actors request', async () => {
  const f = fixture();
  f.window.dpsData = {
    getDetailsContext: () => ({ ...detailsContext(), audienceKnown: false }),
    getTargetDetails: async () => assert.fail('an empty actor filter must never mean all players'),
    getBattleDetail: async () => assert.fail('unknown identity must not use the unfiltered fallback'),
  };
  const details = await f.app.getDetails({ id: 0 }, { targetId: 77 });
  assert.equal(details.totalDmg, 0);
  assert.equal(details.totalHeal, 0);
  assert.equal(details.skills.length, 0);
});

test('a visible healer missing from the damage context keeps their own hover details', async () => {
  const f = fixture();
  f.app.latestRowsById = new Map([['2', row(2, 0, { isPartyMember: true })]]);
  const requests = [];
  f.window.dpsData = {
    getDetailsContext: () => ({ audienceKnown: true, actors: [{ actorId: 1, isLocalPlayer: true }], targets: [] }),
    getBattleDetail: async id => {
      requests.push(id);
      return { ...detailSkills(), skills: [] };
    },
  };
  const details = await f.app.getDetails({ id: 2 });
  assert.deepEqual(requests, [2]);
  assert.equal(details.totalDmg, 0);
  assert.equal(details.totalHeal, 50);
  assert.deepEqual(Array.from(details.healSkills, skill => skill.actorId), [2]);
  const excluded = await f.app.getDetails({ id: 3 }, { attackerIds: [3] });
  assert.equal(excluded.totalHeal, 0);
  assert.deepEqual(requests, [2], 'an unknown actor does not inherit the visible healer fallback');
});

test('saved History details retain their recorded canonical totals', async () => {
  const f = fixture();
  f.window._historyDetailsOverride = detailSkills();
  f.window.dpsData = { getDetailsContext: () => assert.fail('saved history must not be filtered by the current party') };
  const details = await f.app.getDetails({ id: 0 });
  assert.equal(details.totalDmg, 1000);
  assert.equal(details.totalHeal, 950);
  assert.deepEqual(Array.from(details.skills, skill => skill.actorId).sort(), [1, 2, 3]);
});

test('the selector works before identity is known and empty states stay explicit', () => {
  const f = fixture();
  const select = { value: '', dataset: {}, addEventListener(name, callback) { this[name] = callback; } };
  const empty = { hidden: true, textContent: '' };
  f.context.document.querySelector = selector => selector === '.audienceSelect' ? select : selector === '.audienceEmpty' ? empty : null;
  f.app.audienceKnown = false;
  f.app.initAudienceControl();
  assert.equal(select.value, 'party');
  assert.notEqual(select.disabled, true);
  f.app.updateAudienceEmptyState([]);
  assert.equal(empty.hidden, false);
  assert.match(empty.textContent, /waiting/i);
  select.value = 'everyone';
  select.change();
  assert.equal(f.stored.get('dpsMeter.audience'), 'everyone');
  assert.equal(f.app.audience, 'everyone');
  assert.doesNotMatch(empty.textContent, /waiting/i);
  f.app.updateAudienceEmptyState([row(1, 10)]);
  assert.equal(empty.hidden, true);
});

test('narrowing the audience rejects an already awaited Everyone response', async () => {
  const f = fixture({ 'dpsMeter.audience': 'everyone' });
  let release;
  let calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  f.window.dpsData = {
    getDetailsContext: () => detailsContext(),
    getTargetDetails: async () => ++calls === 1 ? pending : detailSkills(),
  };
  const old = f.app.getDetails({ id: 0 }, { targetId: 77 });
  const rejected = assert.rejects(old, /audience|cancel|supersed/i);
  f.app.setAudience('self');
  release(detailSkills());
  await rejected;
  const current = await f.app.getDetails({ id: 0 }, { targetId: 77 });
  assert.equal(current.totalDmg, 100);
  assert.deepEqual(Array.from(current.skills, skill => skill.actorId), [1]);
});

test('a party or character change rejects awaited Details even without changing the selector', async () => {
  for (const next of [{ partyGeneration: 2, localPlayerId: 1, audienceKnown: true }, { partyGeneration: 1, localPlayerId: 9, audienceKnown: true }]) {
    const f = fixture();
    let snapshot = { partyGeneration: 1, localPlayerId: 1, audienceKnown: true };
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    f.window.dpsData = {
      getDpsData: () => JSON.stringify(snapshot),
      getDetailsContext: () => ({ ...detailsContext(), partyGeneration: 1, localPlayerId: 1 }),
      getTargetDetails: async () => pending,
    };
    const old = f.app.getDetails({ id: 0 }, { targetId: 77 });
    const rejected = assert.rejects(old, error => error?.code === 'AUDIENCE_CHANGED');
    snapshot = next;
    release(detailSkills());
    await rejected;
    assert.equal(f.app.audience, 'party');
  }
});

test('narrowing immediately closes an outsider tooltip while its old DOM row still exists', () => {
  const f = fixture({ 'dpsMeter.audience': 'everyone' });
  let visible = true;
  f.context.CSS = { escape: String };
  f.app.lastSnapshot = [row(3, 600)];
  f.app.latestRowsById = new Map([['3', f.app.lastSnapshot[0]]]);
  f.app.hoveredDetailsRowId = 3;
  f.app.hoverTooltipEl = { classList: { contains: () => visible } };
  f.app.elList = { querySelector: () => ({ staleRowStillInDom: true }) };
  f.app.hideHoverTooltip = () => { visible = false; };
  f.app.closeOrphanTooltip = Object.getPrototypeOf(f.app).closeOrphanTooltip.bind(f.app);
  f.app.setAudience('self');
  assert.equal(visible, false);
  assert.equal(f.app.hoveredDetailsRowId, null);
});

test('a cached player absent from authoritative incoming rows loses group visibility', () => {
  const f = fixture();
  const snapshot = [row(1, 100), row(2, 300, { isPartyMember: true })];
  const updated = f.app.updateSnapshotNicknameForUser([row(1, 0)], snapshot);
  assert.deepEqual(ids(f.app.filterRowsByAudience(updated)), ['1']);
  assert.equal(updated.find(r => r.id === '2').totalDamage, 300, 'the old result remains canonical while its display classification changes');
});
