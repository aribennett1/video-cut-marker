/* Compact amplitude reduction adapted from Advanced Video Player/app.js.
   No FFmpeg, remote assets, media persistence or full-file decode for large files. */
class LocalWaveform {
  constructor(video, onChange, onStatus) {
    this.video = video; this.onChange = onChange; this.onStatus = onStatus;
    this.bins = new Float32Array(4096); this.known = new Uint8Array(4096);
    this.generation = 0; this.context = null; this.decodeContext = null;
    this.complete = false;
  }
  reset() {
    this.generation++; this.bins.fill(0); this.known.fill(0); this.complete = false;
    if (this.decodeContext) { this.decodeContext.close().catch(() => {}); this.decodeContext = null; }
    if (this.context?.state === 'running') this.context.suspend().catch(() => {});
  }
  async load(file, duration) {
    const token = this.generation;
    if (file.size > 32 * 1024 * 1024 || duration > 600) {
      this.onStatus('Waveform builds during playback · flat areas not yet analyzed'); return;
    }
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) { this.onStatus('Waveform unavailable · cut marking still works'); return; }
    this.onStatus('Analyzing audio locally…');
    let context;
    try {
      context = new Audio({ sampleRate: 8000 }); this.decodeContext = context;
      const bytes = await file.arrayBuffer();
      if (token !== this.generation) return;
      const audio = await context.decodeAudioData(bytes);
      if (token !== this.generation) return;
      const channel = audio.getChannelData(0);
      // Yield between chunks to keep cut marking responsive.
      for (let i = 0; i < this.bins.length; i++) {
        if (token !== this.generation) return;
        const start = Math.floor(i * channel.length / this.bins.length);
        const end = Math.floor((i + 1) * channel.length / this.bins.length);
        let sum = 0;
        for (let j = start; j < end; j++) sum += Math.abs(channel[j]);
        this.bins[i] = sum / (end - start || 1); this.known[i] = 1;
        if (i % 512 === 0) { this.onStatus(`Analyzing audio locally… ${Math.round(i / this.bins.length * 100)}%`); await new Promise(resolve => setTimeout(resolve, 0)); }
      }
      this.complete = true; this.onChange(); this.onStatus('Waveform ready');
    } catch {
      if (token === this.generation) this.onStatus('Waveform builds during playback · container decode unavailable');
    } finally {
      if (context && context.state !== 'closed') await context.close().catch(() => {});
      if (this.decodeContext === context) this.decodeContext = null;
    }
  }
  async startLive() {
    if (this.complete && !this.context) return;
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    try {
      if (!this.context) {
        this.context = new Audio();
        this.source = this.context.createMediaElementSource(this.video);
        this.analyser = this.context.createAnalyser(); this.analyser.fftSize = 2048;
        this.source.connect(this.analyser); this.analyser.connect(this.context.destination);
        this.samples = new Float32Array(this.analyser.fftSize);
      }
      await this.context.resume();
    } catch { this.onStatus('Waveform unavailable · cut marking still works'); }
  }
  sample() {
    if (this.complete || !this.analyser || this.context.state !== 'running' || this.video.paused || this.video.seeking || !this.video.duration) return;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0; for (const v of this.samples) sum += Math.abs(v);
    const i = Math.min(this.bins.length - 1, Math.floor(this.video.currentTime / this.video.duration * this.bins.length));
    this.bins[i] = Math.max(this.bins[i], sum / this.samples.length); this.known[i] = 1;
  }
  dispose() {
    this.reset(); this.source?.disconnect(); this.analyser?.disconnect();
    this.context?.close().catch(() => {}); this.context = null;
  }
}
