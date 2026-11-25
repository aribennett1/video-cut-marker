const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function setup(Audio) {
  const context = {window:{AudioContext:Audio},Float32Array,Uint8Array,setTimeout,Promise};
  vm.runInNewContext(fs.readFileSync(require.resolve('../waveform.js'),'utf8')+';this.LocalWaveform=LocalWaveform;',context);
  let changed=0; const statuses=[]; const video={paused:false,seeking:false,currentTime:1,duration:100};
  const wave = new context.LocalWaveform(video,()=>changed++,s=>statuses.push(s));
  return {wave,video,statuses,changed:()=>changed};
}
function fakeAudio(overrides={}) {
  const instances=[];
  class Audio {
    constructor(){this.state='running';instances.push(this);Object.assign(this,overrides)}
    async close(){this.state='closed'} async suspend(){this.state='suspended'} async resume(){this.state='running'}
    async decodeAudioData(){return {getChannelData:()=>new Float32Array(8000).fill(.1)}}
    createMediaElementSource(){return {connect(){},disconnect(){}}}
    createAnalyser(){return {fftSize:2048,connect(){},disconnect(){},getFloatTimeDomainData(samples){samples.fill(.1)}}}
  }
  return {Audio,instances};
}
test('large files and long videos never read entire media into JS memory', async()=>{
  const {Audio,instances}=fakeAudio(); const {wave,statuses}=setup(Audio);
  const file={size:33*1024*1024,arrayBuffer(){throw new Error('Must not read')}};
  await wave.load(file,100);await wave.load({...file,size:1},3601);
  assert.equal(instances.length,0);assert.ok(statuses.every(s=>s.includes('playback')));assert.equal(wave.bins.byteLength,16384);
});
test('small supported decode retains compact data and closes its context', async()=>{
  const {Audio,instances}=fakeAudio();const {wave,statuses,changed}=setup(Audio);
  await wave.load({size:1,arrayBuffer:async()=>new ArrayBuffer(1)},1);
  assert.equal(wave.complete,true);assert.equal(instances[0].state,'closed');assert.equal(wave.decodeContext,null);assert.equal(changed(),1);assert.equal(statuses.at(-1),'Waveform ready');
});
test('unsupported decoder and AudioContext construction leave editing independent',async()=>{
  const {Audio,instances}=fakeAudio({decodeAudioData:async()=>{throw new Error('Unsupported')}});const {wave,statuses}=setup(Audio);
  await wave.load({size:1,arrayBuffer:async()=>new ArrayBuffer(1)},1);assert.equal(wave.complete,false);assert.ok(statuses.at(-1).includes('playback'));assert.equal(instances[0].state,'closed');
  const broken=setup(class{constructor(){throw new Error('No audio device')}});await broken.wave.load({size:1},1);assert.ok(broken.statuses.at(-1).includes('playback'));
});
test('changing media cancels stale decoding and never publishes obsolete bins',async()=>{
  let finish;const {Audio,instances}=fakeAudio({decodeAudioData:()=>new Promise(r=>{finish=r})});const {wave,changed}=setup(Audio);
  const job=wave.load({size:1,arrayBuffer:async()=>new ArrayBuffer(1)},1);await Promise.resolve();wave.reset();finish({getChannelData:()=>new Float32Array(8000).fill(1)});await job;
  assert.equal(wave.complete,false);assert.equal(changed(),0);assert.equal(instances[0].state,'closed');assert.ok(wave.bins.every(v=>v===0));
});
test('progressive analyzer resumes routed audio even after a later full decode',async()=>{
  const {Audio,instances}=fakeAudio();const {wave}=setup(Audio);await wave.startLive();wave.sample();assert.ok(wave.known.some(v=>v===1));
  wave.reset();assert.equal(instances[0].state,'suspended');wave.complete=true;await wave.startLive();assert.equal(instances[0].state,'running');wave.dispose();assert.equal(instances[0].state,'closed');
});
