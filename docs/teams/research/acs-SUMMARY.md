# SUMMARY — ACS (Azure Communication Services) as hopeOS's on-ramp into Teams meetings

Topic: **acs** · finished 2026-09-18 · roadmap return path **C3 (ACS participant)** from the Teams pilot memo.
Provenance: first pass (`research_draft1/acs/`) wrote all five deliverables; second pass fetched the larger
primary sources into `_src/`. This finisher kept the draft deliverables (only source of the docs/code), re-verified
every SDK claim against the newer `_src/` copies, fixed two stale points, and added one correction.

## What the topic concluded

1. **ACS is the supported way for an arbitrary web page to sit in a scheduled Teams meeting.** The JS Calling SDK
   joins by `{ meetingLink }` or `{ meetingId, passcode }` (SDK >= 1.17.1); Teams shows us as an "external"
   anonymous participant with our chosen display name; no Teams licence on our side, no interop fee, only
   **$0.004 per participant-minute** for participants on our page (Teams-client participants $0; lobby time bills).
2. **The three primitives hopeOS needs are GA:** (a) any `MediaStream` as the outgoing camera —
   `new LocalVideoStream(canvas.captureStream(30))`, swappable with `setMediaStream()`; (b) every remote video both
   as a rendered element (`VideoStreamRenderer.createView()`) and raw (`remoteVideoStream.getMediaStream()`);
   (c) a **DataChannel** (`Features.DataChannel`, 32 KB/msg, Lossy <= 512 kbps, broadcast <= 80 pkt/s, receiver
   idles out after 2 min) for the ~600 B landmark packets at 30 Hz and ball state.
3. **The same code joins a plain ACS group call by GUID with no tenant at all**, so the three-laptop ball game and
   the latency HUD can be built and measured before any Teams policy question is answered.
4. **No bundler is needed but no drop-in `<script>` build exists for the Calling SDK.** `dist/sdk.bundle.js` is a UMD
   expecting two externals; `dist-esm/sdk.bundle.js` (7.3 MB) has exactly two bare imports (`@azure/logger`,
   `@azure/communication-common`) — verified on the local copy — so an import map + jsDelivr `+esm` for those two is
   the honest path. The jsDelivr `+esm` files import their own deps by root-relative `/npm/...` URLs, which resolve
   against cdn.jsdelivr.net, so nothing else needs mapping.
5. **Tenant gating:** anonymous join is on by default but `DisableAnonymousJoin`, `AllowAnonymousUsersToJoinMeeting`,
   `EnableAcsFederationAccess` or `BlockedAnonymousJoinClientTypes = ACS` can block us; we cannot enter until a Teams
   user is present, then wait in the lobby unless "Who can bypass the lobby" = Everyone (`call.state === 'InLobby'`).
   Teams for Home, E2EE meetings, town halls and live events are not joinable.
6. **Recording/transcription consent gate (new in this pass, from the 1.46.1 typings):** `RecordingCallFeature` and
   `TranscriptionCallFeature` expose `isTeamsConsentRequired` + `grantTeamsConsent()`; when the tenant requires
   explicit consent our audio/video are withheld until we grant it. The client now shows a consent button, plus the
   contractually required recording/transcription banners.
7. **UI Library:** MIT, React-only as an npm package (peer React >=16.8 <19, Fluent v8 + v9), no npm/CDN standalone —
   **but** (correction to the first pass) Microsoft ships prebuilt React-included script bundles on GitHub Releases
   (`callComposite.js` -> `window.callComposite.loadCallComposite(...)`). Still: imitate the CallComposite layout and
   Fluent tokens in vanilla CSS for the twin; use the release bundle only as a one-file "stock Teams look" oracle page.

## Decisions that constrain the design

- Track locally, relay landmarks, render locally (memo decision) — ACS DataChannel is the in-meeting relay candidate;
  the WebSocket relay stays the fallback because **DataChannel between ACS users inside a Teams meeting is undocumented**
  (absent from the external-user capabilities table) and Teams-native clients can never receive it.
- Exactly **one outgoing video per call** -> all hopeOS layers (hands, props, ball) composite onto ONE canvas before the SDK.
- Incoming resolution ladder (1 -> 1080p, 2 -> 720p, **3 -> 540p**, 4-9 -> 360p) -> tracking hands from received video is a
  degraded fallback; everyone in the game should run our page and ship landmarks.
- Rendering caps: 16 remote videos (25 with SDK >= 1.40.0 and 8 cores) on desktop, **4 on mobile**; UI Library default is 4
  remote tiles + overflow strip — the twin gallery should default to the same.
- Send 720p by default (1080p opt-in via `videoOptions.constraints.send`); mute/unmute throttled above 15 toggles / 30 s.
- Tokens: mint server-side only (`acs-token.js`, `voip` scope, 60-1440 min TTL, proactive refresh); never ship the
  connection string; set `ACS_TOKEN_SHARED_SECRET` because every token is billable minutes.
- Browser matrix: Chrome/Edge desktop are the pilot targets; Safari cannot pick speakers, iOS Safari may reload the page
  on app switch and can lose call audio if we call `getUserMedia` ourselves; Firefox desktop is preview.
- Licensing: Calling SDK is proprietary (Microsoft Software License Terms); identity/common/UI-library are MIT.
- The Teams meeting must be scheduled by a licensed Teams user (our Teams contact); a Teams user cannot join a call we start.

## Canonical files (all in `research/acs/`)

| File | What it is | Kept from |
|---|---|---|
| `acs-client.html` | Vanilla ES-module ACS client: import map -> Microsoft's `dist-esm/sdk.bundle.js` (1.46.1) + jsDelivr `+esm` for `@azure/communication-common@2.5.0` and `@azure/logger@1.4.0`; Teams-look shell; `canvas.captureStream(30)` as the outgoing camera via `LocalVideoStream`; remote tiles via `VideoStreamRenderer`; mute/leave; `Features.DataChannel` ball bus; recording/transcription banners + consent button; group-call-by-GUID mode. | canonical (second pass; superset of draft — adds transcription/consent gate and source cross-refs) |
| `acs-token.js` | Vercel Node function (`api/acs-token.js`) minting an ACS identity + `voip` token with `@azure/communication-identity` 1.3.1; env var names, TTL bounds, `x-acs-token-secret` gate, CORS origin, refresh path. | identical in both passes |
| `README.md` | Azure resource setup, bundler-free SDK loading, Teams tenant policy gates, pricing, limits, browser matrix, what does not work for external users, status flags, roadmap hook-in. | canonical (second pass; adds `_src/` evidence table, `node --check` note, consent gate, release-bundle note) |
| `UI-LIBRARY.md` | ACS UI Library (communication-react) structure: CallComposite / CallArrangement / VideoGallery / VideoTile / ControlBar, Fluent tokens, licence, reuse recommendation for the twin. | canonical (second pass; corrects "no CDN build" with the GitHub Releases `callComposite.js` bundle) |
| `SUMMARY.md` | This file. | canonical, completed by the finisher (2026-09-18) |
| `_src/` | Local primary sources: `communication-calling-1.46.1.d.ts`, `sdk.bundle.esm.js`, the two mapped `+esm` deps, `identity-1.3.1.d.ts`, `manage-calls-web.md`, `manage-video-web.md`, `relnotes.md`, `ui_*` (UI Library sources, loader, JS-bundle docs, licence). | canonical (draft only had `calling.d.ts` + `relnotes.md`) |

Draft copies in `research_draft1/acs/` are strictly older versions of the same five files; nothing needed to be copied back.

## Verification record (finisher, 2026-09-18)

No verify script (`verify-harness.mjs`, `test-mock.mjs`, `_probe-minimal.mjs`, `examples/smoke-test.mjs`) exists for this topic,
so the checks below are what could be run locally without an Azure resource:

- `grep` of `_src/sdk.bundle.esm.js` bare imports: exactly two — `@azure/communication-common`, `@azure/logger` — matching the
  import map in `acs-client.html`. `CallClient`, `LocalVideoStream`, `VideoStreamRenderer`, `Features` are all exported.
- `_src/communication-calling-1.46.1.d.ts`: `Features.Recording`, `Features.Transcription`, `Features.DataChannel` present;
  `isTeamsConsentRequired` / `grantTeamsConsent()` present on both Recording and Transcription features (6 hits).
- `node --check acs-token.js`: OK.
- The `<script type="module">` body of `acs-client.html` extracted (367 lines) and `node --check`-ed as `.mjs`: OK.
- **Not done:** a browser run against a live ACS resource / Teams meeting. That needs an Azure subscription + connection string
  (see README section 2) and is the first pilot step. The import-map load path, lobby flow, DataChannel-inside-Teams-meeting and
  the consent gate are all first-run risks.

## Risks

- First-run risk on the import-map path (module format verified locally, never executed in a browser).
- DataChannel between ACS users inside a Teams meeting is undocumented (absent from the external-user capabilities table); fallback
  is the roadmap's WebSocket relay. Teams-native clients can never receive DataChannel packets.
- Tenant policy can block ACS clients specifically (`BlockedAnonymousJoinClientTypes = ACS`); no Teams user present -> cannot connect.
- Consent gate: if the tenant requires explicit recording/transcription consent and we do not grant it, our canvas silently never
  reaches the Teams gallery.
- Proprietary Calling SDK licence, 7.3 MB payload; Safari/iOS instability for the camera-compositing approach.
- An unguarded token endpoint mints billable identities — keep `ACS_TOKEN_SHARED_SECRET` set.
- Docs disagree on captions/reactions for external users (capabilities table yes, older concept page no) — test.

## Open questions

- Does the pilot tenant allow ACS anonymous join and lobby bypass for the demo meeting?
- Does DataChannel deliver between ACS participants inside a Teams meeting?
- Will the Teams contacts accept "external"-labelled participants, or do they want us on Microsoft 365 identities (CTE path,
  different licensing)?
- Is 540p incoming video good enough for hopeOS tracking of a remote Teams-client participant, or must every player run our page?
- Which loader signature does the released `callComposite.js` bundle expect (`{ locator, displayName, userId, token }` per the
  storybook doc vs `{ userId, credential, ... }` per `_src/ui_callCompositeLoader.ts`)?

## Sources

Primary (local copies in `_src/`): `@azure/communication-calling@1.46.1` typings + `dist-esm/sdk.bundle.js` (jsDelivr);
`@azure/communication-common@2.5.0` and `@azure/logger@1.4.0` `+esm`; `@azure/communication-identity@1.3.1` typings;
Learn how-tos `manage-calls` / `manage-video` (web pivot); ACS JS calling release notes; `Azure/communication-ui-library`
sources (CallComposite.tsx, CallArrangement.tsx, VideoGallery.tsx, VideoTile.tsx, ControlBar.tsx, themes.ts,
AzureCommunicationCallAdapter.ts, callCompositeLoader.ts, javascript-loaders.ts, JavaScriptBundle_Docs.mdx, LICENSE.md).

Learn pages read online (first pass):
- quickstarts/voice-video-calling: get-started-teams-interop, get-started-raw-media-access, get-started-video-effects,
  get-started-video-constraints, get-started-data-channel, get-started-with-video-calling, optimizing-video-placement
- how-tos/calling-sdk: teams-interoperability, manage-calls, manage-video
- concepts: voice-video-calling/data-channel, voice-video-calling/calling-sdk-features, known-issues, service-limits,
  authentication, join-teams-meeting, interop/guest/{overview,meeting-capabilities,teams-administration},
  pricing, pricing/teams-interop-pricing, ui-library/ui-library-overview
- quickstarts/identity/access-tokens (JS + portal pivots), quickstarts/create-communication-resource
- registry.npmjs.org (`@azure/communication-calling`, `@azure/communication-identity`), data.jsdelivr.com package listing,
  cdn.jsdelivr.net package.json / README / LICENSE for calling, common, calling-effects
- github.com/Azure/Communication release notes; github.com/Azure/azure-sdk-for-js communication-common README;
  github.com/Azure/communication-ui-library (README, LICENSE, package.json, docs, releases)
- vercel.com/docs/functions/runtimes/node-js; MDN HTMLCanvasElement/captureStream
