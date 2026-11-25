/* Pure project rules; shared by the browser and Node's built-in tests. */
const CutCore = (() => {
  const STORAGE_KEY = 'video-cut-marker.projects.v1';
  function integer(value, name = 'Timestamp') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative integer.`);
    return value;
  }
  function toUs(seconds) { return integer(Math.round(seconds * 1e6)); }
  function format(us) {
    integer(us);
    const ms = Math.floor(us / 1000);
    return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  }
  function parse(text) {
    const m = /^(\d{2,}):([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(text.trim());
    if (!m) throw new Error('Enter a timestamp as HH:MM:SS.mmm.');
    return integer((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1e6 + Number(m[4]) * 1000);
  }
  function range(cut, durationUs) {
    if (!cut || typeof cut !== 'object') throw new Error('Invalid cut.');
    integer(durationUs, 'Duration'); integer(cut.startUs); integer(cut.endUs);
    if (cut.endUs <= cut.startUs) throw new Error('The end must be after the start.');
    if (cut.endUs > durationUs) throw new Error('A cut cannot extend beyond the video.');
    return { startUs: cut.startUs, endUs: cut.endUs };
  }
  function sorted(cuts, durationUs) {
    if (!Array.isArray(cuts)) throw new Error('Cuts must be an array.');
    const result = cuts.map(c => range(c, durationUs)).sort((a, b) => a.startUs - b.startUs);
    if (result.some((c, i) => i && c.startUs < result[i - 1].endUs)) throw new Error('Cuts overlap. Merge them explicitly or adjust their boundaries.');
    return result;
  }
  function merge(cuts, durationUs) {
    const result = [];
    for (const c of cuts.map(c => range(c, durationUs)).sort((a, b) => a.startUs - b.startUs)) {
      const last = result.at(-1);
      if (last && c.startUs <= last.endUs) last.endUs = Math.max(last.endUs, c.endUs);
      else result.push({ ...c });
    }
    return result;
  }
  function totals(cuts, durationUs) {
    const removedUs = sorted(cuts, durationUs).reduce((n, c) => n + c.endUs - c.startUs, 0);
    return { removedUs, finishedUs: durationUs - removedUs };
  }
  function skipTarget(positionUs, cuts) {
    // Chaining also skips adjacent ranges, including a cut at the very end.
    let target = positionUs;
    for (const c of cuts) if (target >= c.startUs && target < c.endUs) target = c.endUs;
    return target;
  }
  function identity(file) { return JSON.stringify([file.name, file.size, file.lastModified]); }
  function source(value) {
    if (!value || typeof value.fileName !== 'string' || !value.fileName.trim()) throw new Error('Missing source filename.');
    integer(value.fileSizeBytes, 'File size'); integer(value.durationUs, 'Duration');
    if (!value.durationUs) throw new Error('Video duration must be positive.');
    return { fileName: value.fileName, fileSizeBytes: value.fileSizeBytes, durationUs: value.durationUs };
  }
  function exportData(project, now = new Date().toISOString()) {
    const s = source(project);
    return { schemaVersion: 1, operation: 'remove', timeUnit: 'microseconds', source: s,
      cuts: sorted(project.cuts, s.durationUs), exportedAt: now };
  }
  function importData(data) {
    if (!data || data.schemaVersion !== 1 || data.operation !== 'remove' || data.timeUnit !== 'microseconds') throw new Error('Unsupported cut-list schema, operation or timestamp units.');
    const s = source(data.source);
    if (typeof data.exportedAt !== 'string' || !Number.isFinite(Date.parse(data.exportedAt))) throw new Error('Missing or invalid export date.');
    return { ...s, cuts: sorted(data.cuts, s.durationUs) };
  }
  function validateProject(p) {
    source(p);
    if (p.schemaVersion !== 1) throw new Error('Unsupported saved project version.');
    integer(p.fileLastModified, 'File date'); integer(p.positionUs, 'Playback position');
    if (p.positionUs > p.durationUs) throw new Error('Invalid saved playback position.');
    if (p.pendingUs !== null && (integer(p.pendingUs) > p.durationUs)) throw new Error('Invalid pending cut.');
    if (!Number.isFinite(Date.parse(p.updatedAt))) throw new Error('Invalid saved date.');
    return { ...p, cuts: sorted(p.cuts, p.durationUs) };
  }
  function readProjects(storage) {
    const text = storage.getItem(STORAGE_KEY);
    if (text === null) return {};
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid project storage.');
    const result = {};
    for (const [key, p] of Object.entries(data)) {
      const validated = validateProject(p);
      if (key !== identity({ name: p.fileName, size: p.fileSizeBytes, lastModified: p.fileLastModified })) throw new Error('Invalid project identity.');
      Object.defineProperty(result, key, { value: validated, enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
  function writeProjects(storage, projects) {
    for (const p of Object.values(projects)) validateProject(p);
    storage.setItem(STORAGE_KEY, JSON.stringify(projects));
  }
  return { STORAGE_KEY, integer, toUs, format, parse, range, sorted, merge, totals, skipTarget, identity, exportData, importData, readProjects, writeProjects, validateProject };
})();
if (typeof module !== 'undefined') module.exports = CutCore;
