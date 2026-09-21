# video-effects - SUMMARY (finisher, 2026-09-18)

Topic: the Teams **video-effect / "video filter" app** surface (return path **C2** in the pilot memo): a sideloaded
Teams meeting app whose side-panel page receives every outgoing camera frame via `@microsoft/teams-js`
`videoEffects` and writes the processed frame back onto the wire.

## What the topic concluded

1. **The surface exists and is fully specified in the SDK source, but it is beta, dev-preview-only, undocumented
   beyond an API reference, and unproven in the current Teams client.** `videoEffects` is `@beta` in teams-js 2.56.0
   (2026-09-02); `meetingExtensionDefinition.videoFilters` / `videoFiltersConfigurationUrl` exist only in the
   DevPreview manifest schema (GA v1.16-1.25 contain zero occurrences; ajv rejects the manifest under GA 1.25).
   No store path; sideload only, tenant must allow custom app upload. The only public sample
   (microsoft/teams-videoapp-sample) targets the pre-2.12 API and has an unanswered July-2025 issue (#24) saying
   filters list but never apply in new Teams 25163 (infinite spinner).
2. **Two frame transports, host-chosen.** *mediaStream* (new Teams on Windows / WebView2 experimental TextureStream:
   `window.chrome.webview.getTextureStream` / `registerTextureStream`, origin-gated by `AddAllowedOrigin`) delivers a
   WebCodecs `VideoFrame` and expects a new `VideoFrame` back; *sharedFrame* (classic/Electron Teams and the sample
   Electron test app) delivers an NV12 `Uint8ClampedArray` to edit in place. An app MUST register both handlers.
   The format enum has a single member, `NV12`.
3. **Frame budget:** "at least 22fps for 720p" -> at most 45 ms per frame, serial; default host limit 100 ms with
   `frameProcessingSlow` telemetry; videoEffectsEx adds a 2000 ms hard warn. Measured with no inference: 3-10 ms avg
   at 360p/720p in headless Chrome 152. MediaPipe hand inference must therefore run in a Worker with frame-skip and
   the NV12 conversion should move to WebGL (the sample shader) to stay under budget.
4. **A video filter is single-participant.** It sees only the local camera and writes only the local outgoing
   stream; there is no cross-participant channel. Cross-tile ball passing needs a separate state channel
   (Live Share / own relay / meeting-stage app) with each participant filter rendering the shared state into its
   own stream - consistent with the memo: track locally, relay landmark packets, render everyone locally.
5. **Together mode custom scenes are retired** (MC1296478, June 2026); `videoFilters` is the only remaining
   AR-style meeting surface and it is dev-preview only.
6. **`videoEffectsEx`** (private, "Microsoft-internal") adds camera-less synthesis (`requireCameraStream:false`),
   host-side audio inference, runtime thumbnail lists (`updatePersonalizedEffects`) and fatal errors; callable but
   hosts decide whether to honour it. Not a pilot dependency.

## Decisions that constrain the design

- Treat C2 as **experimental / probe-first**: budget one dev-tenant probe (Windows new Teams, Public preview ring,
  custom app upload on, sideload the zip) before building on it. Expected outcomes: works, or the issue-#24 spinner.
- Keep the effect logic in a host-agnostic module (`effect-core.js`) with BOTH handlers so the same code runs under
  the harness, under Teams, and under a virtual-camera fallback (C1) via `canvas.captureStream()`.
- Pin teams-js **2.56.0** and MediaPipe tasks-vision **0.10.18** (the hopeOS pinned version; `ImageSource` accepts a
  `VideoFrame` directly in both 0.10.18 and 1.0.1). Self-host teams-js, wasm, .task and three.js on the
  `validDomains` origin - whether CDN sub-resources need listing is undocumented.
- Manifest: `manifestVersion: "devPreview"`, RSC `CameraStream.Read.User` + `OutgoingVideoStream.Write.User`
  (Delegated; both documented in the Learn RSC page), filter names `Category_Name`, thumbnails in the zip, tile
  `data-id` values in the page must equal `videoFilters[].id`.
- The Learn capability matrix (video = Android/iOS only, yet the two effect-selection APIs "not supported on
  mobile") is self-contradictory; the code says desktop. Ask the Teams contacts the three verbatim questions in
  NOTES.md section 8.5.
- The hopeOS doctrines (frozen mpbrowser/rig, prop collision, measured z-sign) are untouched: the filter is a render
  sink; tracking + physics stay in the existing hopeOS modules and only their overlay is composited into the frame.

## Canonical files (this folder)

| file | one line |
|---|---|
| `manifest.json` | DevPreview Teams manifest for the filter app (3 filters + RSC); validates against the DevPreview schema |
| `manifest.annotated.jsonc` | same manifest with the provenance of every field (schema line refs, Learn URLs, sample commits) |
| `video-effect.html` | the page Teams loads: real teams-js 2.56.0 UMD from the Microsoft CDN, `registerForVideoEffect` / `registerForVideoFrame` (both handlers) / `notifySelectedVideoEffectChanged`, harness shim for WebView2 TextureStream, MediaPipe tracker stub |
| `effect-core.js` | host-agnostic frame core: `videoFrameHandler` (VideoFrame in/out), `videoBufferHandler` (NV12 in place), `onEffectChanged`, stats; pluggable `createTracker` / `render` |
| `host-harness.html` | local Teams-host twin: Mode A (in-process mediaStream / sharedFrame), Mode B (real SDK in an iframe over the real postMessage protocol), HUD with ms/frame |
| `serve.mjs` | static server with COOP/COEP (SharedArrayBuffer) on port 8787 |
| `verify-harness.mjs` | puppeteer-core driver: fake camera, all four modes, prints PASS/FAIL + JSON stats |
| `NOTES.md` | full research notes: API, wire messages, host modes, budget, sample/test app, videoEffectsEx, beta/store/admin status, harness log, hopeOS implications |
| `_tools/validate-manifest.cjs` | ajv (draft-04) validation of manifest.json against `_src/schema_DevPreview.json` |
| `_src/` | fetched primary sources: teams-js public + private `.ts`, CHANGELOG, runtime/communication/validOrigins, sample repo, DevPreview + GA v1.19-1.25 schemas, BCD JSON, MediaPipe `vision.d.ts` 0.10.18 + 1.0.1, Learn RSC md |

Versions kept: all code deliverables are the **canonical** (14:2x-14:33) versions - they are supersets of the draft
with line-cited comments; `manifest.json` and `serve.mjs` are byte-identical in both. `NOTES.md` existed only in
the draft; copied and patched (`src/` -> `_src/`, RSC now verified via `_src/rsc.md`, GA schema list extended to
1.25, ajv proof, MediaPipe 0.10.18 vs 1.0.1 line refs, fresh timing run). `SUMMARY.md` and
`_tools/validate-manifest.cjs` are new.

## Verification log (finisher run, 2026-09-18)

`node verify-harness.mjs` - Chrome 152.0.7977.83 headless, puppeteer-core 25.3.0, fake camera at 20 fps, page served
with COOP/COEP (`crossOriginIsolated=true`). One harmless `404` console error (favicon).

| mode | 640x360 frames / avg / max ms | 1280x720 frames / avg / max ms | result |
|---|---|---|---|
| A-mediaStream (in-process) | 96 / 3.5 / 12.7 | 96 / 8.7 / 18.5 | PASS |
| A-sharedFrame (NV12 via canvas) | 98 / 3.2 / 8.9 | 99 / 9.7 / 16.9 | PASS |
| B-mediaStream (real SDK, VideoFrame relay) | 150 relayed; app-side avg 4.8-7.0 / max 18.5 | 150; app-side avg 8-10.5 / max 24.4 | PASS |
| B-sharedFrame (real SDK, SAB NV12 round trip) | 143 / 2.6 / 22.2 | 149 / 9.8 / 24.8 | PASS |

The Mode B trace confirms the full handshake with teams-js 2.56.0: `initialize` -> `getContext` ->
`video.registerForVideoEffect` -> `video.mediaStream.registerForVideoFrame [{"format":"NV12"}]` (or
`video.registerForVideoFrame` for sharedFrame) -> host `video.setFrameProcessTimeLimit` +
`video.startVideoExtensibilityVideoStream` -> `video.performance.textureStreamAcquired` -> tile click ->
`video.videoEffectChanged` -> host `video.effectParameterChange` -> `video.videoEffectReadiness [true, id]` ->
`firstFrameProcessed` -> `performanceDataGenerated` every second. 0 `notifyError`.

`cd _tools && node validate-manifest.cjs` -> `manifest valid: true` (DevPreview, draft-04). The same manifest
re-stamped as 1.25 against `_src/ga_v1.25.json` -> invalid: additional properties `videoFilters`,
`videoFiltersConfigurationUrl` (and `packageName`).

What the harness does NOT prove: that new Teams still surfaces third-party filters and emits
`video.startVideoExtensibilityVideoStream` for them, and WebView2 `AddAllowedOrigin` gating.

## Sources (all copies in `_src/`; URLs in NOTES.md)

teams-js `main` 2026-09-18: `public/videoEffects.ts`, `private/videoEffectsEx.ts`, `internal/videoEffectsUtils.ts`,
`videoPerformanceMonitor.ts`, `videoFrameTick.ts`, `runtime.ts`, `communication.ts`, `validOrigins.ts`, `app.ts`,
CHANGELOG.md, package.json (2.56.0); OfficeDev/microsoft-teams-app-schema DevPreview schema; GA schemas v1.19-1.25;
microsoft/teams-videoapp-sample (manifest, index.js, webgl-video-filter.js, vite.config.js, README, releases,
issues #23/#24); Learn: videoEffects API reference, teamsjs-support-m365 matrix, manifest reference (m365-app-prev
vs 1.19-1.30), Public Developer Preview, RSC reference (rsc.md), ICoreWebView2ExperimentalTextureStream,
Set-CsTeamsMeetingPolicy; mdn/browser-compat-data (MediaStreamTrackProcessor/Generator, VideoFrame); MediaPipe
tasks-vision vision.d.ts 0.10.18 and 1.0.1; MC1296478 + Teams/Office365ITPros posts on Together-mode retirement;
support.microsoft.com "Apply video filters in Teams meetings".