const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const C = require('../core.js');
// Exercise the actual cut-list handlers with media/render boundaries stubbed.
function controls(cuts, mode = 'original') {
  class Element {
    constructor(tag) { this.tag=tag; this.children=[]; this.dataset={}; this.handlers={}; this.attributes={}; this.value=''; }
    append(...children) { for (const c of children) { this.children.push(c); if (typeof c === 'object') c.parentElement=this; } }
    replaceChildren(...children) { this.children=[]; this.append(...children); }
    addEventListener(name, handler) { this.handlers[name]=handler; }
    setAttribute(name, value) { this.attributes[name]=value; }
    focus() { state.focused=this; }
    querySelector(selector) {
      const [attribute, value] = selector.match(/\[data-([\w-]+)="([^"]+)"\]/).slice(1);
      const key=attribute.replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
      const boundary=selector.match(/\[data-boundary="([^"]+)"\]/)?.[1];
      return all(this).find(e=>String(e.dataset[key])===value && (!boundary || e.dataset.boundary===boundary)) || null;
    }
  }
  function all(el) { return el.children.flatMap(c=>typeof c==='object'?[c,...all(c)]:[]); }
  const host = new Element('div');
  const state={mode,seeks:[],plays:[],saves:0,errors:[],focused:null};
  const source=fs.readFileSync(require.resolve('../app.js'),'utf8');
  const renderSource=source.slice(source.indexOf('function renderCuts()'),source.indexOf('function renderRegions()'));
  const editSource=source.slice(source.indexOf('function editBoundary('),source.indexOf('function render()'));
  const project={durationUs:10000000,cuts:structuredClone(cuts)};
  const box={C, project, selected:-1, document:{createElement:tag=>new Element(tag)},
    $:id=>id === 'mode' ? { value: state.mode } : host, renderCuts:null,
    safely(fn){try{return fn()}catch(e){state.errors.push(e.message);return false}},
    button(text,action){const b=new Element('button');b.textContent=text;b.addEventListener('click',()=>box.safely(action));return b},
    applyCuts(candidate,cut){ project.cuts=C.sorted(candidate,project.durationUs);box.selected=project.cuts.findIndex(c=>c.startUs===cut.startUs&&c.endUs===cut.endUs);state.saves++;box.renderCuts();return true },
    seek(us){state.seeks.push(us)},play(){state.plays.push(state.mode)},notice(text){state.errors.push(text)},
  };
  vm.createContext(box);vm.runInContext(editSource+'\n'+renderSource+'\nrenderCuts();',box);
  const inputs=()=>all(host).filter(e=>e.tag==='input');
  const arrows=(boundary,direction)=>all(host).find(e=>e.dataset.boundary===boundary)?.parentElement.querySelector(`[data-direction="${direction}"]`);
  return {project,state,inputs,arrows,host};
}
test('each arrow steps by 0.1 seconds; edited previews start before the cut start',()=>{
  for(const mode of ['original','edited']) for(const boundary of ['startUs','endUs']) for(const direction of ['up','down']) {
    const c=controls([{startUs:2800417,endUs:7000123}],mode);const before=c.project.cuts[0][boundary];
    c.arrows(boundary,direction).handlers.click();
    const expected=before+(direction==='up'?100000:-100000);
    assert.equal(c.project.cuts[0][boundary],expected);
    assert.deepEqual(c.state.seeks,[(mode === 'edited' ? c.project.cuts[0].startUs : expected)-1000000]);assert.deepEqual(c.state.plays,[mode]);assert.equal(c.state.saves,1);
    assert.equal(c.state.focused.dataset.direction,direction);
    // A second click uses the current value after rerendering.
    c.arrows(boundary,direction).handlers.click();
    assert.equal(c.project.cuts[0][boundary],expected+(direction==='up'?100000:-100000));
  }
});
test('preview clamps to zero and never seeks before the recording',()=>{
  const c=controls([{startUs:200000,endUs:800000}]);c.arrows('endUs','up').handlers.click();assert.deepEqual(c.state.seeks,[0]);
});
test('invalid and overlapping boundary steps leave cuts unchanged and do not play',()=>{
  for(const [cuts,boundary,direction] of [
    [[{startUs:0,endUs:1000000}],'startUs','down'],
    [[{startUs:1000000,endUs:1100000}],'startUs','up'],
    [[{startUs:9000000,endUs:10000000}],'endUs','up'],
    [[{startUs:0,endUs:1000000},{startUs:1050000,endUs:2000000}],'endUs','up'],
  ]) { const c=controls(cuts);c.arrows(boundary,direction).handlers.click();assert.deepEqual(c.project.cuts,cuts);assert.equal(c.state.errors.length,1);assert.deepEqual(c.state.plays,[]);assert.deepEqual(c.state.seeks,[]); }
});
test('formatted timestamp entry previews; invalid entry is rejected',()=>{
  const c=controls([{startUs:2800417,endUs:7000123}]);let input=c.inputs()[0];assert.equal(input.value,'00:00:02:800');
  input.value='00:00:03:123';input.handlers.change();assert.equal(c.project.cuts[0].startUs,3123000);assert.deepEqual(c.state.seeks,[2123000]);
  for(const bad of ['oops','-1','Infinity','2.1234567','999999999999999999999']) { input=c.inputs()[0];input.value=bad;input.handlers.change();assert.equal(c.project.cuts[0].startUs,3123000);assert.equal(input.value,'00:00:03:123'); }
});
test('keyboard arrows use the same increments and preview behavior',()=>{
  const c=controls([{startUs:2800000,endUs:7000000}]);let prevented=false;
  c.inputs()[1].handlers.keydown({key:'ArrowDown',preventDefault(){prevented=true}});assert.equal(prevented,true);assert.equal(c.project.cuts[0].endUs,6900000);assert.deepEqual(c.state.seeks,[5900000]);
});

test('edited end adjustments from typing and keyboard preview one second before start',()=>{
  const c=controls([{startUs:2800000,endUs:7000000}], 'edited');
  c.inputs()[1].value='00:00:07:200';c.inputs()[1].handlers.change();
  assert.equal(c.project.cuts[0].endUs,7200000);assert.deepEqual(c.state.seeks,[1800000]);
  c.inputs()[1].handlers.keydown({key:'ArrowDown',preventDefault(){}});
  assert.equal(c.project.cuts[0].endUs,7100000);assert.deepEqual(c.state.seeks,[1800000,1800000]);
  assert.deepEqual(c.state.plays,['edited','edited']);
});

test('display formatting and unchanged input retain hidden microsecond precision',()=>{
  const c=controls([{startUs:2800417,endUs:7000123}]);
  c.inputs()[0].handlers.change();assert.equal(c.project.cuts[0].startUs,2800417);assert.equal(c.state.saves,0);
  c.arrows('startUs','up').handlers.click();assert.equal(c.project.cuts[0].startUs,2900417);assert.equal(c.inputs()[0].value,'00:00:02:900');
});
