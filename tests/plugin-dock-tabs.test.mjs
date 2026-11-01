import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const source = readFileSync(new URL("../public/src/js/pluginDock.js", import.meta.url), "utf8");
function body(name) {
  const start = source.indexOf("  const " + name + " = ");
  const from = source.indexOf("=>", start) + 2, open = source.indexOf("{", from);
  let end = open + 1, depth = 1;
  while (depth) { if (source[end] === "{") depth++; else if (source[end] === "}") depth--; end++; }
  return source.slice(source.indexOf("=", start) + 1, end).trim();
}
const element = () => ({style:{setProperty(){}},children:[],attributes:{},listeners:{},
  classList:{toggle(){}},setAttribute(k,v){this.attributes[k]=v},append(x){this.children.push(x)},
  appendChild(x){this.children.push(x)},replaceChildren(){this.children=[]},
  addEventListener(k,fn){this.listeners[k]=fn}});
function setup(states) {
  const entries = states.map(([id, shown]) => ({id,shown,name:id,version:"1.0",panel:element(),tab:element()}));
  const tabsEl=element(),calls=[],errors=[],prefs={active:entries[0]?.id,layout:"tabs",folded:false,order:[],compact:{}};
  const context=vm.createContext({prefs,tabsEl,layoutBtn:element(),foldBtn:element(),docked:new Map(entries.map(d=>[d.id,d])),
    ordered:()=>entries,shownTabs:()=>entries.filter(d=>d.shown),setLabel(){},savePrefs(){},setFolded(){},
    t:(_key,fallback)=>fallback,document:{body:element(),createElement:element},
    window:{A2_PLUGIN_ICON:()=>({glyph:null,hue:20,letter:"C"})},showToast:e=>errors.push(e),
    invoke:(name,args)=>{calls.push({name,args});entries.find(d=>d.id===args.id).shown=true;return Promise.resolve();}
  });
  vm.runInContext("const render="+body("render")+";const activate="+body("activate")+";const makeTab="+body("makeTab")+";globalThis.api={render,makeTab};",context);
  for(const d of entries)d.tab=context.api.makeTab(d);
  return {entries,tabsEl,calls,errors,prefs,api:context.api};
}
test("hidden panels retain configuration tabs without revealing their content",()=>{
  const s=setup([["cooldowns",true],["boss-telegraph",false]]);
  s.api.render();assert.equal(s.tabsEl.children.length,2);assert.equal(s.entries[1].panel.hidden,true);
  s.entries[0].shown=false;s.api.render();
  assert.equal(s.tabsEl.children.length,2);assert.ok(s.entries.every(d=>d.panel.hidden));
  assert.equal(s.calls.length,0);
});
test("clicking a retained tab reopens that plugin through the host",async()=>{
  const s=setup([["cooldowns",false]]);s.api.render();
  await s.entries[0].tab.listeners.click();
  await Promise.resolve();
  assert.equal(s.calls[0].name,"plugin_open");assert.equal(s.calls[0].args.id,"cooldowns");
  assert.equal(s.prefs.active,"cooldowns");assert.equal(s.entries[0].panel.hidden,false);
  assert.deepEqual(s.errors,[]);
});
test("a manual click on a visible tab records configuration intent without recreating its panel",async()=>{
  const s=setup([["cooldowns",true],["boss-telegraph",true]]);s.api.render();
  const panel=s.entries[1].panel;
  await s.entries[1].tab.listeners.click();await Promise.resolve();
  assert.equal(s.prefs.active,"boss-telegraph");assert.equal(s.calls.length,1);
  assert.equal(s.entries[1].panel,panel);
});
