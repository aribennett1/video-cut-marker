'use strict';
const C = CutCore;
const $ = id => document.getElementById(id);
const video = $('video');
let project = null, projectKey = null, mediaUrl = null, openToken = 0;
let projects = {}, storageBlocked = false, saveTimer = null;
let selected = -1, presentedUs = null, requestedUs = null;
let preview = null, previewModeBefore = 'original', dragging = null;
let lastPaint = 0, lastSample = 0;
function notice(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); }
function safely(action) { try { return action(); } catch (e) { notice(e.message, true); return false; } }
try { projects = C.readProjects(localStorage); }
catch { storageBlocked = true; notice('Saved projects could not be read. Existing storage is preserved. You can still edit and export; automatic saving is unavailable.', true); }
const wave = new LocalWaveform(video, drawWaveform, text => { $('wave-status').textContent = text; });
function position() {
  if (!project) return 0;
  return Math.max(0, Math.min(project.durationUs, requestedUs ?? (video.seeking ? C.toUs(video.currentTime) : presentedUs ?? C.toUs(video.currentTime))));
}
function seek(us) {
  if (!project) return;
  requestedUs = Math.max(0, Math.min(project.durationUs, Math.round(us)));
  presentedUs = null;
  if (Math.abs(video.currentTime - requestedUs / 1e6) < 0.0000005) requestedUs = null;
  else video.currentTime = requestedUs / 1e6;
  updatePosition();
}
function persist(immediate = true) {
  if (!project) return;
  if (!immediate) {
    if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; persist(); }, 2000);
    return;
  }
  clearTimeout(saveTimer); saveTimer = null;
  project.positionUs = position(); project.updatedAt = new Date().toISOString();
  projects[projectKey] = structuredClone(project);
  if (storageBlocked) { $('save-status').textContent = 'Not saved · export to keep progress'; return; }
  try { C.writeProjects(localStorage, projects); $('save-status').textContent = 'Saved in this browser'; }
  catch { $('save-status').textContent = 'Saving failed · export to keep progress'; notice('Browser storage is unavailable or full. Export your cut list to keep completed cuts.', true); }
  renderProjects();
}
function button(text, action, className = '') {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.className = className;
  b.addEventListener('click', () => safely(action)); return b;
}
function renderProjects() {
  const host = $('projects'); host.replaceChildren();
  const entries = Object.entries(projects).sort((a,b) => Date.parse(b[1].updatedAt) - Date.parse(a[1].updatedAt));
  if (!entries.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Your recent videos will appear here. Reopen the same file to restore your marks.'; host.append(p); }
  for (const [key, p] of entries) {
    const row = document.createElement('div'); row.className = 'project';
    const info = document.createElement('div'); const name = document.createElement('strong'); name.textContent = p.fileName;
    const meta = document.createElement('small'); const percent = Math.round(p.positionUs / p.durationUs * 100);
    meta.textContent = `${p.cuts.length} cuts · ${new Date(p.updatedAt).toLocaleString()} · ${percent}% reviewed`;
    const progress = document.createElement('progress'); progress.max = p.durationUs; progress.value = p.positionUs; progress.setAttribute('aria-label', `${p.fileName}: ${percent}% reviewed`);
    info.append(name, meta, progress);
    const actions = document.createElement('div'); actions.className = 'project-actions';
    actions.append(button('Reopen video', () => { notice(`Choose “${p.fileName}” from your device to restore its saved cuts.`); $('file').click(); }), button('Delete', () => {
      if (!confirm(`Delete saved progress for “${p.fileName}”? Your video is unaffected.`)) return;
      const next = { ...projects }; delete next[key];
      if (storageBlocked) throw new Error('Storage could not be read, so it cannot safely be changed.');
      C.writeProjects(localStorage, next); projects = next;
      if (key === projectKey) { project.cuts = []; project.pendingUs = null; selected = -1; render(); }
      renderProjects(); notice('Saved project deleted.');
    })); row.append(info, actions); host.append(row);
  }
}
async function openFile(file) {
  if (!file) return;
  persist(); const token = ++openToken;
  stopIndividual(); video.pause(); wave.reset();
  video.removeAttribute('src'); video.load();
  if (mediaUrl) URL.revokeObjectURL(mediaUrl);
  mediaUrl = URL.createObjectURL(file); project = null; projectKey = null; requestedUs = presentedUs = null;
  selected = -1; $('workspace').hidden = true; $('welcome').hidden = false;
  notice(`Opening ${file.name}…`);
  video.onloadedmetadata = () => safely(() => {
    if (token !== openToken) return;
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('This video has no usable duration. Try another format.');
    const durationUs = C.toUs(video.duration); const key = C.identity(file);
    let restored = projects[key];
    if (restored && restored.durationUs !== durationUs) {
      if (!confirm('This file has a different duration from its saved project. Restore compatible saved timestamps? Cancel starts a new project.')) restored = null;
      else { C.sorted(restored.cuts, durationUs); if (restored.pendingUs > durationUs) throw new Error('The saved pending cut is beyond this video.'); }
    }
    if (!restored) {
      const collisions = Object.values(projects).filter(p => p.fileName === file.name && C.identity({name:p.fileName,size:p.fileSizeBytes,lastModified:p.fileLastModified}) !== key);
      if (collisions.length) {
        const candidate = collisions.sort((a,b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
        if (confirm(`A saved project named “${file.name}” has different file metadata. Restore its ${candidate.cuts.length} cuts to this file? Cancel starts a separate project.`)) { C.sorted(candidate.cuts, durationUs); if (candidate.pendingUs > durationUs) throw new Error('The saved pending cut is beyond this video.'); restored = candidate; }
      }
    }
    project = { schemaVersion: 1, fileName: file.name, fileSizeBytes: file.size, fileLastModified: file.lastModified, durationUs,
      cuts: restored ? structuredClone(restored.cuts) : [], pendingUs: restored?.pendingUs ?? null,
      positionUs: Math.min(restored?.positionUs ?? 0, durationUs), updatedAt: new Date().toISOString() };
    projectKey = key; $('filename').textContent = file.name; $('workspace').hidden = false; $('welcome').hidden = true;
    $('mode').value = 'original'; $('zoom').value = '1'; $('timeline').style.width = '100%';
    seek(project.positionUs); render(); persist();
    notice(restored ? 'Saved cuts and playback position restored.' : 'Ready. Play your video and mark the sections to remove.');
    wave.load(file, video.duration).catch(() => { if (token === openToken) $('wave-status').textContent = 'Waveform unavailable · cut marking still works'; });
  });
  video.onerror = () => { if (token === openToken) notice('The browser could not play this file. Try a browser-supported MP4 or WebM video.', true); };
  video.src = mediaUrl; video.load();
}
function applyCuts(candidate, selectCut = null) {
  let result;
  try { result = C.sorted(candidate, project.durationUs); }
  catch (e) {
    candidate.forEach(c => C.range(c, project.durationUs));
    if (!confirm(`${e.message}\nMerge the overlapping and adjacent regions?`)) return false;
    result = C.merge(candidate, project.durationUs);
  }
  project.cuts = result;
  selected = selectCut ? result.findIndex(c => c.startUs <= selectCut.startUs && c.endUs >= selectCut.endUs) : -1;
  stopIndividual(); render(); persist(); return true;
}
function mark() {
  if (!project) return;
  if (project.pendingUs === null) { project.pendingUs = position(); notice('Cut started. Continue to its end, then select End Cut.'); }
  else {
    const cut = C.range({ startUs: project.pendingUs, endUs: position() }, project.durationUs);
    if (!applyCuts([...project.cuts, cut], cut)) return;
    project.pendingUs = null; notice('Cut added. The original timeline stays unchanged.');
  }
  render(); persist();
}
function cancelCut() { if (!project || project.pendingUs === null) return; project.pendingUs = null; render(); persist(); notice('Pending cut canceled.'); }
function editBoundary(index, boundary, value) {
  const cut = { ...project.cuts[index], [boundary]: value };
  C.range(cut, project.durationUs);
  return applyCuts(project.cuts.map((c,i) => i === index ? cut : c), cut);
}
function render() {
  if (!project) return;
  $('mark').replaceChildren(document.createTextNode(project.pendingUs === null ? 'Start Cut ' : 'End Cut '));
  const kbd = document.createElement('kbd'); kbd.textContent = 'C'; $('mark').append(kbd);
  $('cancel').hidden = project.pendingUs === null;
  $('mark-hint').textContent = project.pendingUs === null ? 'At the part you don’t want? Mark its beginning.' : `Cut starts at ${C.format(project.pendingUs)}. Mark its ending.`;
  $('count').textContent = project.cuts.length; $('duration').textContent = `/ ${C.format(project.durationUs)}`;
  const t = C.totals(project.cuts, project.durationUs);
  $('original-total').textContent = C.format(project.durationUs); $('removed-total').textContent = C.format(t.removedUs); $('finished-total').textContent = C.format(t.finishedUs);
  renderCuts(); renderRegions(); updatePosition(); drawWaveform();
}
function renderCuts() {
  const host = $('cuts'); host.replaceChildren();
  if (!project.cuts.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'No cuts yet. Use Start Cut and End Cut while watching.'; host.append(p); }
  project.cuts.forEach((cut, index) => {
    const card = document.createElement('article'); card.className = `cut${selected === index ? ' active' : ''}`;
    const heading = document.createElement('div'); heading.className = 'cut-heading';
    heading.append(button(`Cut ${index + 1}`, () => { selected = index; render(); }), button('Delete', () => { project.cuts.splice(index, 1); selected = -1; stopIndividual(); render(); persist(); notice('Cut deleted.'); }));
    const times = document.createElement('div'); times.className = 'cut-times';
    for (const [boundary, label] of [['startUs', 'Start'], ['endUs', 'End']]) {
      const field = document.createElement('label'); field.className = 'cut-time-field';
      const caption = document.createElement('span'); caption.textContent = `${label} (seconds)`;
      const spinner = document.createElement('div'); spinner.className = 'time-spinner';
      const input = document.createElement('input'); input.type = 'text'; input.inputMode = 'decimal';
      input.value = (cut[boundary] / 1e6).toFixed(6).replace(/(\.\d{3}\d*?)0+$/, '$1');
      input.dataset.boundary = boundary; input.dataset.cutIndex = index;
      input.setAttribute('aria-label', `Cut ${index + 1} ${label.toLowerCase()} in seconds`);
      const original = input.value;
      function commit(value, focusTarget = 'input') {
        const changed = safely(() => editBoundary(index, boundary, value));
        if (!changed) { input.value = original; return false; }
        const updatedIndex = selected;
        const newInput = $('cuts').querySelector(`input[data-cut-index="${updatedIndex}"][data-boundary="${boundary}"]`);
        const target = focusTarget === 'input' ? newInput : newInput?.parentElement.querySelector(`[data-direction="${focusTarget}"]`);
        target?.focus({ preventScroll: true });
        const previewBoundary = $('mode').value === 'edited' ? 'startUs' : boundary;
        seek(Math.max(0, project.cuts[updatedIndex][previewBoundary] - 1000000));
        play();
        return true;
      }
      input.addEventListener('change', () => {
        if (input.value === original) return;
        if (!/^\d+(?:\.\d{1,6})?$/.test(input.value.trim())) { input.value = original; notice('Enter seconds with up to six decimal places.', true); return; }
        if (!safely(() => commit(C.toUs(Number(input.value))))) input.value = original;
      });
      input.addEventListener('keydown', event => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault(); commit(cut[boundary] + (event.key === 'ArrowUp' ? 100000 : -100000));
      });
      const arrows = document.createElement('div'); arrows.className = 'time-arrows';
      for (const [direction, delta, glyph] of [['up', 100000, '▲'], ['down', -100000, '▼']]) {
        const arrow = button(glyph, () => commit(cut[boundary] + delta, direction));
        arrow.dataset.direction = direction;
        arrow.setAttribute('aria-label', `${direction === 'up' ? 'Increase' : 'Decrease'} cut ${index + 1} ${label.toLowerCase()} by 0.1 seconds`);
        arrow.title = `${direction === 'up' ? '+' : '−'}0.1 s · preview from one second before ${label.toLowerCase()} (cut start in edited mode)`;
        arrows.append(arrow);
      }
      spinner.append(input, arrows); field.append(caption, spinner); times.append(field);
    }
    const length = document.createElement('p'); length.className = 'cut-length'; length.textContent = `${C.format(cut.endUs - cut.startUs)} removed`;
    card.append(heading, times, length);
    host.append(card);
  });
}
function renderRegions() {
  if (!project) return;
  const host = $('regions'); host.replaceChildren();
  project.cuts.forEach((cut, index) => {
    const region = document.createElement('div'); region.className = `region${selected === index ? ' selected' : ''}`;
    region.style.left = `${cut.startUs / project.durationUs * 100}%`; region.style.width = `${(cut.endUs - cut.startUs) / project.durationUs * 100}%`;
    region.title = `Cut ${index + 1}: ${C.format(cut.startUs)} to ${C.format(cut.endUs)}`;
    const label = document.createElement('span'); label.className = 'region-label'; label.textContent = `Cut ${index + 1}`; region.append(label);
    region.addEventListener('click', event => { event.stopPropagation(); selected = index; render(); });
    if (selected === index) for (const [boundary, className] of [['startUs','start'], ['endUs','end']]) {
      const handle = button('', () => {}); handle.className = `handle ${className}`; handle.setAttribute('aria-label', `Drag cut ${index + 1} ${className}; use the timestamp fields for keyboard controls`);
      handle.addEventListener('pointerdown', event => {
        event.preventDefault(); event.stopPropagation();
        dragging = { index, boundary, value: cut[boundary], handle }; handle.setPointerCapture(event.pointerId);
      });
      handle.addEventListener('pointermove', event => {
        if (!dragging || dragging.handle !== handle) return;
        const rect = $('timeline').getBoundingClientRect(); dragging.value = Math.round(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * project.durationUs);
        const start = boundary === 'startUs' ? dragging.value : cut.startUs; const end = boundary === 'endUs' ? dragging.value : cut.endUs;
        region.style.left = `${Math.min(start,end) / project.durationUs * 100}%`; region.style.width = `${Math.abs(end-start) / project.durationUs * 100}%`;
        region.title = `${C.format(start)} – ${C.format(end)}`;
      });
      handle.addEventListener('pointerup', event => {
        if (!dragging) return;
        const { value } = dragging; dragging = null; handle.releasePointerCapture(event.pointerId);
        safely(() => editBoundary(index, boundary, value)); renderRegions();
      });
      handle.addEventListener('pointercancel', () => { dragging = null; renderRegions(); });
      region.append(handle);
    }
    host.append(region);
  });
  if (project.pendingUs !== null) {
    const region = document.createElement('div'); region.className = 'region pending'; region.id = 'pending-region'; host.append(region); updatePending();
  }
}
function updatePending() {
  const region = $('pending-region'); if (!region || !project) return;
  const p = position(); region.style.left = `${Math.min(project.pendingUs,p) / project.durationUs * 100}%`; region.style.width = `${Math.abs(p - project.pendingUs) / project.durationUs * 100}%`;
}
function drawWaveform() {
  if (!project) return;
  // Only paint the visible viewport: zoom never allocates a huge canvas.
  const scroll = $('timeline-scroll'), canvas = $('waveform');
  const width = scroll.clientWidth; if (!width) return;
  const dpr = Math.min(devicePixelRatio || 1, 2), height = 108;
  canvas.style.width = `${width}px`; canvas.style.left = `${scroll.scrollLeft}px`;
  if (canvas.width !== Math.round(width*dpr) || canvas.height !== height*dpr) { canvas.width = Math.round(width*dpr); canvas.height = height*dpr; }
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,width,height);
  ctx.fillStyle = '#a6ed91';
  const fullWidth = $('timeline').clientWidth;
  for (let x = 0; x < width; x += 2) {
    const index = Math.min(4095, Math.floor((x + scroll.scrollLeft) / fullWidth * 4096));
    const h = wave.known[index] ? Math.max(1,Math.min(48,wave.bins[index]*48*7)) : 1;
    ctx.globalAlpha = wave.known[index] ? .85 : .3; ctx.fillRect(x,54-h,1.5,h*2);
  }
  ctx.globalAlpha = 1;
  const ruler = $('ruler'); ruler.replaceChildren();
  const startUs = scroll.scrollLeft / fullWidth * project.durationUs; const spanUs = width / fullWidth * project.durationUs;
  const step = [100000,500000,1000000,5000000,10000000,30000000,60000000,300000000,600000000,1800000000,3600000000].find(v => spanUs/v <= width/110) || 7200000000;
  for (let us = Math.ceil(startUs/step)*step; us < Math.min(project.durationUs,startUs+spanUs); us += step) {
    const tick = document.createElement('span'); tick.style.left = `${us/project.durationUs*100}%`; tick.textContent = C.format(us); ruler.append(tick);
  }
}
function updatePosition() {
  if (!project) return;
  const p = position(); $('clock').textContent = C.format(p); $('playhead').style.left = `${p/project.durationUs*100}%`; updatePending();
  if ($('follow').checked && !video.paused && !dragging) {
    const scroll = $('timeline-scroll'); const x = p/project.durationUs * $('timeline').clientWidth;
    if (x > scroll.scrollLeft+scroll.clientWidth-25 || x < scroll.scrollLeft) { scroll.scrollLeft = Math.max(0,x-scroll.clientWidth*.25); }
  }
}
function enforcePreview() {
  if (!project || video.paused || video.seeking) return;
  const current = C.toUs(video.currentTime);
  if (preview && current >= preview.stopUs) { video.pause(); stopIndividual(); notice('Cut preview complete.'); return; }
  if ($('mode').value === 'edited') {
    const target = C.skipTarget(current, project.cuts);
    if (target !== current) {
      seek(target);
      if (target >= project.durationUs || (preview && target >= preview.stopUs)) { video.pause(); stopIndividual(); }
    }
  }
}
function stopIndividual() {
  if (!preview) return;
  preview = null; $('mode').value = previewModeBefore;
}
async function play() {
  if (!project) return;
  // If the media element has already been routed to Web Audio, resume it even
  // after a later file's waveform is fully decoded.
  await wave.startLive();
  try { await video.play(); } catch (e) { notice(`Playback could not start: ${e.message}`, true); }
}
function togglePlay() { if (video.paused) play(); else video.pause(); }
function previewCut(index) {
  stopIndividual(); const cut = project.cuts[index]; selected = index;
  previewModeBefore = $('mode').value; preview = { stopUs: Math.min(project.durationUs,cut.endUs+3000000) };
  $('mode').value = 'edited'; seek(Math.max(0,cut.startUs-3000000)); render(); play();
  notice(`Previewing transition around Cut ${index+1}.`);
}
$('file').addEventListener('change', () => { const file = $('file').files[0]; $('file').value = ''; openFile(file).catch(e => notice(e.message,true)); });
$('mark').addEventListener('click', () => safely(mark)); $('cancel').addEventListener('click', cancelCut);
$('play').addEventListener('click', togglePlay);
for (const [id, amount] of [['back',-5000000],['forward',5000000],['fine-back',-10000],['fine-forward',10000]]) $(id).addEventListener('click', () => { stopIndividual(); seek(position()+amount); });
$('speed').addEventListener('change', () => { video.playbackRate = Number($('speed').value); });
$('mode').addEventListener('change', () => { preview = null; enforcePreview(); });
$('zoom').addEventListener('input', () => { $('timeline').style.width = `${Number($('zoom').value)*100}%`; drawWaveform(); updatePosition(); });
$('timeline-scroll').addEventListener('scroll', drawWaveform, { passive: true });
$('waveform').addEventListener('click', event => { if (!project) return; stopIndividual(); const rect = $('timeline').getBoundingClientRect(); seek((event.clientX-rect.left)/rect.width * project.durationUs); });
window.addEventListener('resize', drawWaveform);
video.addEventListener('play', () => { $('play').textContent = 'Pause'; wave.startLive(); });
video.addEventListener('pause', () => { $('play').textContent = 'Play'; persist(); });
video.addEventListener('seeking', () => { presentedUs = null; if (requestedUs === null) requestedUs = C.toUs(video.currentTime); });
video.addEventListener('seeked', () => { requestedUs = null; presentedUs = null; updatePosition(); persist(); enforcePreview(); });
video.addEventListener('timeupdate', () => { updatePosition(); persist(false); enforcePreview(); });
video.addEventListener('ended', stopIndividual);
if ('requestVideoFrameCallback' in video) {
  const frame = (_, metadata) => { if (project && !video.seeking && requestedUs === null) presentedUs = C.toUs(metadata.mediaTime); enforcePreview(); video.requestVideoFrameCallback(frame); };
  video.requestVideoFrameCallback(frame);
}
function tick(now) {
  if (project && now-lastPaint>50) { lastPaint = now; updatePosition(); enforcePreview(); }
  if (project && !video.paused && now-lastSample>100) { lastSample=now; wave.sample(); if (!wave.complete) drawWaveform(); }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
window.addEventListener('pagehide', () => persist());
document.addEventListener('visibilitychange', () => { if (document.hidden) persist(); });
document.addEventListener('keydown', event => {
  if (!project || event.ctrlKey || event.metaKey || event.altKey || event.target.closest('input,textarea,select,button,a,summary,video,[contenteditable="true"]')) return;
  if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
  else if (event.key.toLowerCase() === 'c') { event.preventDefault(); safely(mark); }
  else if (event.key === 'Escape') { event.preventDefault(); cancelCut(); }
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); stopIndividual(); seek(position()+(event.key==='ArrowLeft'?-1:1)*(event.shiftKey?10000:5000000)); }
});
$('export').addEventListener('click', () => safely(() => {
  if (!project) return;
  const data = C.exportData(project); const url = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)+'\n'], {type:'application/json'}));
  const link = document.createElement('a'); link.href=url; link.download=project.fileName.replace(/\.[^.]+$/, '')+'.cuts.json'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url),1000);
  notice(`Exported ${data.cuts.length} completed cuts.${project.pendingUs!==null?' The pending cut was excluded.':''}`);
}));
$('import').addEventListener('change', async () => {
  const file = $('import').files[0]; $('import').value=''; if (!file || !project) return;
  const key = projectKey;
  try {
    if (file.size > 5*1024*1024) throw new Error('This cut list is too large (limit: 5 MiB).');
    const data = C.importData(JSON.parse(await file.text()));
    if (key !== projectKey) throw new Error('The video changed during import. Select the JSON again.');
    C.sorted(data.cuts, project.durationUs);
    if (data.fileName!==project.fileName || data.fileSizeBytes!==project.fileSizeBytes || data.durationUs!==project.durationUs) {
      if (!confirm('This cut list identifies a different source video. Import its timestamps into the current video anyway?')) return;
    }
    if ((project.cuts.length || project.pendingUs!==null) && !confirm('Replace the current cut list and pending cut with the imported cuts?')) return;
    project.cuts = data.cuts; project.pendingUs=null; selected=-1; stopIndividual(); render(); persist(); notice(`Imported ${data.cuts.length} validated cuts.`);
  } catch (e) { notice(`Import failed: ${e.message}`,true); }
});
renderProjects();
