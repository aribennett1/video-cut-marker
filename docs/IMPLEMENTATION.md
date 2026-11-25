# Implementation plan and source review

Source reviewed: `/Users/ericbennett/Video Player`, including app.js, index.html,
position-store.js, styles and the Node test suite. It is a buildless native HTML
video player with canvas waveform rendering and Node's built-in test runner.

Reuse native video controls, object URL playback, compact amplitude summarization
(the original 4096-bin reducer), click-to-seek, playback speed, throttled position
saving and explicit resource ownership. Replace queues and queue sessions with
versioned per-file projects. Omit playlists, audio-only mode, repeat, FFmpeg WASM,
its vendors, and the cross-origin isolation service worker.

Architecture (implementation sequence):
1. core.js: pure integer-microsecond time, range validation, explicit merging,
   preview decisions, import/export and validated project persistence.
2. waveform.js: cancellable browser audio analysis and bounded canvas data.
3. app.js / index.html / styles.css: single-project controller, original timeline,
   editable cuts, preview, recent projects and accessible responsive controls.
4. Tests using node:test, static Pages deployment and documented manual QA.

## Browser constraints

requestVideoFrameCallback supplies actual presented media time where available;
while a seek is pending we use its requested position and label it accordingly.
Fine seeking is 10 ms, explicitly not a presumed frame duration. Browsers do not
expose dependable previous/next-frame stepping or VFR frame indexes. No fixed
frame-rate assumptions are made. Native seeking and preview skips are approximate.

The old waveform depended on FFmpeg WASM, explicitly excluded by this PRD.
Browser decodeAudioData support for video containers varies. Files <= 32 MiB and
10 minutes get a best-effort 8 kHz decode, retaining only compact amplitudes and
closing the context. Larger/unsupported files build a progressive waveform from
native media playback using Web Audio. Unknown regions stay flat and labeled;
this avoids retaining a full recording or decoding gigabytes. Seeking does not
analyze skipped audio. All editing remains available without Web Audio. A full
up-front waveform for arbitrary long video requires a future streaming demuxer
and decoder; it is not provided by the native video element.

## Storage and interchange

All canonical times are nonnegative safe integer microseconds. Formatted inputs
show milliseconds but unchanged edits preserve hidden microsecond precision.
localStorage namespace: video-cut-marker.projects.v1. Keys encode filename, size
and lastModified. No media, handles or waveform data are persisted. Playback saves
are throttled to two seconds; mutations, pause and pagehide flush immediately.
Corrupt storage is never silently replaced. Quota failures are surfaced.

Export schema: ../cuts.schema.json. Operation remove, original source timeline,
sorted nonoverlapping complete ranges. Imports validate before offering explicit
replacement; source mismatches require a second confirmation. Local metadata is
never imported as video content.
