/* Real Chromium QA, no npm dependencies. Needs a local Chrome and native ffmpeg
   solely to generate a tiny test video; ffmpeg is never part of the app. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {spawn, execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(r=>setTimeout(r,ms));
async function waitFor(fn, description) {
  const until = Date.now()+12000;
  while (Date.now()<until) { const result=await fn(); if(result) return result; await delay(80); }
  throw new Error(`Timed out: ${description}`);
}
class CDP {
  constructor(ws) {
    this.ws=ws; this.id=0; this.pending=new Map(); this.errors=[];
    ws.addEventListener('message',event=>{ const m=JSON.parse(event.data); if(m.id){const p=this.pending.get(m.id);this.pending.delete(m.id);if(m.error)p.reject(new Error(JSON.stringify(m.error)));else p.resolve(m.result);} else if(m.method==='Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails); });
  }
  call(method,params={}) { return new Promise((resolve,reject)=>{ const id=++this.id;this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params})); }); }
  async evaluate(expression) { const r=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true}); if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; }
}
(async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'cut-marker-qa-'));
  let chrome, client, server;
  try {
    const fixture=path.join(temp,'sample.mp4');
    execFileSync(process.env.FFMPEG_PATH || 'ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=640x360:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','12','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',fixture]);
    server=http.createServer(async(req,res)=>{
      try { const pathname=new URL(req.url,'http://localhost').pathname; const name=pathname==='/'?'index.html':pathname.slice(1); if(!/^[\w.\/-]+$/.test(name)||name.includes('..'))throw new Error(); const content=await fs.readFile(path.join(root,name));res.setHeader('Content-Type',({'html':'text/html','js':'text/javascript','css':'text/css','svg':'image/svg+xml','json':'application/json'})[name.split('.').at(-1)]||'application/octet-stream');res.end(content); }
      catch {res.statusCode=404;res.end('Not found');}
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
    const profile=path.join(temp,'profile');
    chrome=spawn(process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--autoplay-policy=no-user-gesture-required','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
    chrome.on('error',e=>{console.error(e.message)});
    const port=await waitFor(async()=>{try{return (await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]}catch{return null}},'Chrome debug port');
    const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})});
    client=new CDP(ws); await client.call('Runtime.enable'); await client.call('Page.enable');
    const url=`http://127.0.0.1:${server.address().port}/`;
    await client.call('Page.navigate',{url}); await waitFor(()=>client.evaluate('typeof openFile === "function"'),'app loaded');
    const evaluate=code=>client.evaluate(code);
    async function upload(selector,file) {
      const doc=await client.call('DOM.getDocument');const node=await client.call('DOM.querySelector',{nodeId:doc.root.nodeId,selector});
      await client.call('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[file]});
    }
    await upload('#file',fixture); await waitFor(()=>evaluate('!!project'),'video metadata');
    assert.equal(await evaluate('project.fileName'),'sample.mp4');
    await evaluate("seek(1123456);$('mark').click();seek(2345678);$('mark').click();");
    assert.deepEqual(await evaluate('project.cuts'),[{startUs:1123456,endUs:2345678}]);
    assert.equal(await evaluate("$('count').textContent"),'1');
    assert.equal(await evaluate('video.paused'),true);
    // Real file decoding is best effort, independent of cut creation.
    await waitFor(()=>evaluate('wave.complete || $("wave-status").textContent.includes("playback")'),'waveform generation');
    await evaluate("selected=0;render();const input=document.querySelector('.time-spinner input');input.value='00:00:01:250';input.dispatchEvent(new Event('change',{bubbles:true}));");
    assert.equal(await evaluate('project.cuts[0].startUs'),1250000);
    await evaluate('video.pause()');
    await evaluate("window.confirm=()=>false;seek(1500000);mark();seek(3000000);mark();");
    assert.equal(await evaluate('project.cuts.length'),1); assert.equal(await evaluate('project.pendingUs'),1500000);
    await evaluate("window.confirm=()=>true;mark();");
    assert.deepEqual(await evaluate('project.cuts'),[{startUs:1250000,endUs:3000000}]);
    // Pending cut, exact timestamps and paused position survive a full reload.
    await evaluate('seek(4500000);mark();persist();');
    await client.call('Page.reload'); await waitFor(()=>evaluate('typeof openFile === "function"'),'reload');
    assert.equal(await evaluate('Object.values(projects)[0].pendingUs'),4500000);
    await upload('#file',fixture); await waitFor(()=>evaluate('!!project'),'restore project');
    assert.equal(await evaluate('project.pendingUs'),4500000);
    assert.deepEqual(await evaluate('project.cuts'),[{startUs:1250000,endUs:3000000}]);
    // Native key events mark/cancel; text entry is never intercepted.
    await evaluate('cancelCut();document.body.tabIndex=-1;document.body.focus();');
    await client.call('Input.dispatchKeyEvent',{type:'keyDown',key:'c',code:'KeyC'});
    assert.notEqual(await evaluate('project.pendingUs'),null);
    await client.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
    assert.equal(await evaluate('project.pendingUs'),null);
    // Download an actual JSON export.
    await client.call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:temp});
    await evaluate("$('export').click()");
    const exported=await waitFor(async()=>{try{return JSON.parse(await fs.readFile(path.join(temp,'sample.cuts.json'),'utf8'))}catch{return null}},'JSON download');
    assert.equal(exported.operation,'remove'); assert.deepEqual(exported.cuts,[{startUs:1250000,endUs:3000000}]);
    const bad=path.join(temp,'bad.json');await fs.writeFile(bad,JSON.stringify({...exported,timeUnit:'seconds'}));
    await upload('#import',bad);await waitFor(()=>evaluate('$("notice").textContent.startsWith("Import failed")'),'invalid import');
    assert.equal(await evaluate('project.cuts.length'),1);
    await evaluate("window.confirm=()=>true;project.cuts=[];render();");await upload('#import',path.join(temp,'sample.cuts.json'));
    await waitFor(()=>evaluate('project.cuts.length===1'),'valid import');
    // Edited playback skips real media, including an initial cut.
    await evaluate("project.cuts=[{startUs:0,endUs:2000000}];$('mode').value='edited';seek(0);play();");
    await waitFor(()=>evaluate('video.currentTime>=2 && !video.paused'),'preview skipped cut');
    await evaluate('video.pause();previewCut(0);');
    await waitFor(()=>evaluate('preview===null && video.paused'),'individual cut preview stops');
    // Switching media revokes the old object URL and resets compact data.
    await evaluate("window.revoked=[];const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{window.revoked.push(url);revoke(url)};");
    await upload('#file',fixture);await waitFor(()=>evaluate('!!project'),'reopen media');
    assert.equal(await evaluate('window.revoked.length'),1);
    // Responsive page should not create a horizontal page scrollbar.
    for(const width of [1440,390]) {
      await client.call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<600});
      await delay(150);assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,`no page overflow at ${width}px`);
    }
    await client.call('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    await evaluate('selected=0;render();');await delay(100);
    const screenshot=await client.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
    const screenshotPath=process.env.QA_SCREENSHOT || path.join(os.tmpdir(),'video-cut-marker-qa.png');await fs.writeFile(screenshotPath,Buffer.from(screenshot.data,'base64'));
    assert.deepEqual(client.errors,[],'no uncaught browser exceptions');
    console.log('PASS: real video, waveform fallback, cut marking, boundary editing, overlap choices, reload restoration, keyboard, JSON download/import, edited playback, individual preview, URL cleanup and mobile layout.');
    console.log(`Screenshot: ${screenshotPath}`);
  } catch (error) {
    if (client) { console.error('Browser exceptions:', JSON.stringify(client.errors)); console.error('Page:', await client.evaluate('({url:location.href,title:document.title,body:document.body?.innerText?.slice(0,600)})').catch(()=>null)); }
    throw error;
  } finally {
    client?.ws.close();chrome?.kill('SIGTERM');
    if(server)await new Promise(r=>server.close(r));
    await delay(300);await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
})().catch(e=>{console.error(e);process.exitCode=1});
