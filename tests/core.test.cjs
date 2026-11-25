const {test} = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const durationUs = 3_665_000_000;
const a = {startUs:0,endUs:20417000}, b = {startUs:86250000,endUs:116083000};
const project = () => ({schemaVersion:1,fileName:'recording.mp4',fileSizeBytes:483920184,fileLastModified:1234,durationUs,cuts:[a,b],pendingUs:142333417,positionUs:150000000,updatedAt:'2026-11-25T03:00:00.000Z'});
function storage() { const m = new Map(); return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v)}; }
test('conversion preserves subsecond and microsecond precision', () => {
  for (const us of [0,1,417,999999,20417000,3665000000,123456789123]) assert.equal(C.toUs(us/1e6),us);
  assert.throws(()=>C.toUs(NaN)); assert.throws(()=>C.toUs(Infinity)); assert.throws(()=>C.toUs(-1));
});
test('timestamps display milliseconds with hour rollover and parse strictly', () => {
  assert.equal(C.format(3665417123),'01:01:05.417'); assert.equal(C.format(0),'00:00:00.000');
  assert.equal(C.format(100*3600e6),'100:00:00.000'); assert.equal(C.parse('01:01:05.417'),3665417000);
  for (const s of ['1','00:60:00.000','00:00:60.000','00:00:01.4','-00:00:01.000']) assert.throws(()=>C.parse(s));
});
test('chronological creation, modification and deletion never shift other ranges', () => {
  const input=[b,a]; const result=C.sorted(input,durationUs); assert.deepEqual(result,[a,b]); assert.deepEqual(input,[b,a]);
  const modified=C.sorted([{...a,endUs:a.endUs+417},b],durationUs); assert.deepEqual(modified[1],b);
  assert.deepEqual(C.sorted(modified.filter((_,i)=>i!==0),durationUs),[b]);
});
test('zero, subsecond, whole-video and duration-ending ranges are valid', () => {
  for (const c of [{startUs:0,endUs:1},{startUs:durationUs-417,endUs:durationUs},{startUs:0,endUs:durationUs}]) assert.deepEqual(C.range(c,durationUs),c);
});
test('invalid, incomplete, fractional and unsafe ranges are rejected', () => {
  for (const c of [null,{}, {startUs:1,endUs:1},{startUs:2,endUs:1},{startUs:-1,endUs:2},{startUs:0,endUs:durationUs+1},{startUs:0.5,endUs:2},{startUs:0,endUs:Infinity},{startUs:0,endUs:Number.MAX_SAFE_INTEGER+1}]) assert.throws(()=>C.range(c,durationUs));
});
test('overlaps are rejected, adjacent ranges allowed, merge includes chains', () => {
  const cuts=[{startUs:1,endUs:10},{startUs:9,endUs:12},{startUs:12,endUs:15},{startUs:30,endUs:40}];
  assert.throws(()=>C.sorted(cuts,durationUs),/overlap/);
  assert.deepEqual(C.merge(cuts,durationUs),[{startUs:1,endUs:15},{startUs:30,endUs:40}]);
  assert.equal(C.sorted([{startUs:0,endUs:1},{startUs:1,endUs:2}],durationUs).length,2);
});
test('totals use the original duration without cumulative rounding', () => {
  assert.deepEqual(C.totals([{startUs:0,endUs:1},{startUs:10,endUs:427}],1000),{removedUs:418,finishedUs:582});
  assert.deepEqual(C.totals([{startUs:0,endUs:durationUs}],durationUs),{removedUs:durationUs,finishedUs:0});
  const cuts=Array.from({length:100},(_,i)=>({startUs:i*10000,endUs:i*10000+417})); assert.equal(C.totals(cuts,durationUs).removedUs,41700);
});
test('preview skips a cut at zero, exact starts, adjacent cuts and the final cut', () => {
  const cuts=[{startUs:0,endUs:10},{startUs:10,endUs:20},{startUs:90,endUs:100}];
  for(const [p,expected] of [[0,20],[9,20],[10,20],[20,20],[50,50],[90,100],[100,100]]) assert.equal(C.skipTarget(p,cuts),expected);
});
test('export is versioned, sorted, excludes pending and preserves all precision', () => {
  const p=project(); p.cuts=[{startUs:142333417,endUs:152750123},a]; const data=C.exportData(p);
  assert.equal(data.timeUnit,'microseconds'); assert.equal(data.operation,'remove'); assert.equal(data.schemaVersion,1);
  assert.deepEqual(data.cuts,[a,p.cuts[0]]); assert.equal(data.pendingUs,undefined); assert.equal(data.source.durationUs,durationUs);
  const restored=C.importData(JSON.parse(JSON.stringify(data))); assert.deepEqual(restored.cuts,data.cuts);
});
test('import rejects invalid schema, dates, metadata, units and overlaps', () => {
  const data=C.exportData(project());
  for(const override of [{schemaVersion:2},{operation:'keep'},{timeUnit:'seconds'},{exportedAt:'invalid'},{source:{...data.source,fileName:''}},{source:{...data.source,fileSizeBytes:-1}},{cuts:[a,a]},{cuts:[{startUs:0,endUs:durationUs+1}]},{cuts:null}]) assert.throws(()=>C.importData({...data,...override}));
});
test('per-video storage restores pending, progress and precision, with name collisions', () => {
  const store=storage(); const p=project(), other={...project(),fileSizeBytes:2};
  const key=C.identity({name:p.fileName,size:p.fileSizeBytes,lastModified:p.fileLastModified});
  const otherKey=C.identity({name:other.fileName,size:other.fileSizeBytes,lastModified:other.fileLastModified});
  assert.notEqual(key,otherKey); assert.notEqual(key,C.identity({name:p.fileName,size:p.fileSizeBytes,lastModified:2}));
  C.writeProjects(store,{[key]:p,[otherKey]:other}); assert.deepEqual(C.readProjects(store),{[key]:p,[otherKey]:other});
  const next=C.readProjects(store); delete next[key]; C.writeProjects(store,next); assert.deepEqual(C.readProjects(store),{[otherKey]:other});
});
test('corrupt or future storage is not silently lost; quota failures propagate', () => {
  const store=storage(); assert.deepEqual(C.readProjects(store),{});
  for(const raw of ['{','null','[]',JSON.stringify({x:project()}),JSON.stringify({x:{...project(),schemaVersion:2}})]) {
    store.setItem(C.STORAGE_KEY,raw); assert.throws(()=>C.readProjects(store)); assert.equal(store.getItem(C.STORAGE_KEY),raw);
  }
  assert.throws(()=>C.writeProjects({setItem:()=>{throw new Error('quota')}},{}),/quota/);
});
test('restoration rejects invalid pending, position and project boundaries', () => {
  for (const patch of [{pendingUs:durationUs+1},{pendingUs:undefined},{positionUs:durationUs+1},{positionUs:-1},{fileLastModified:-1},{cuts:[a,a]}]) assert.throws(()=>C.validateProject({...project(),...patch}));
});
