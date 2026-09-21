# ACS (Azure Communication Services) as the way our page joins a Teams meeting

Researched 2026-09-18 against Microsoft Learn, the `@azure/communication-calling@1.46.1`
type definitions, the npm/jsDelivr registries and the `Azure/communication-ui-library` repo.
Finished 2026-09-18 (second pass): every SDK claim below was re-checked against the local copies in `_src/`.
Files in this folder:

| File | What it is |
| --- | --- |
| `acs-client.html` | Vanilla-JS (no bundler) page: token → `CallClient` → join Teams meeting by link / meeting-ID / ACS group call → canvas `captureStream(30)` as our camera → remote tiles → mute/leave → DataChannel game bus. |
| `acs-token.js` | Vercel Node function issuing identity + `voip` token with `@azure/communication-identity`. |
| `UI-LIBRARY.md` | How the ACS UI Library (React, MIT) composites are structured and what we can reuse for the twin. |
| `SUMMARY.md` | Summary, decisions, verification record, full source list. |
| `_src/` | Local evidence: `communication-calling-1.46.1.d.ts` (typings), `sdk.bundle.esm.js` (the exact ESM file the import map loads), `esm__azure_communication-common_2.5.0__esm.js` + `esm__azure_logger_1.4.0__esm.js` (the two mapped deps), `identity-1.3.1.d.ts`, `manage-calls-web.md` / `manage-video-web.md` (Learn how-tos), `relnotes.md`, `ui_*.ts/.tsx/.mdx/.md` (UI Library sources). |

## 1. What ACS gives us, in one paragraph

An ACS "bring-your-own-identity" user can join a **scheduled Teams meeting** from any web page with the
JavaScript Calling SDK; Teams sees it as an **anonymous external participant** with a configurable display
name that Teams labels "external". No Teams license is needed for that user and there is no extra
interop fee, only normal ACS per-minute consumption. [join-teams-meeting](https://learn.microsoft.com/en-us/azure/communication-services/concepts/join-teams-meeting),
[guest overview](https://learn.microsoft.com/en-us/azure/communication-services/concepts/interop/guest/overview).
The SDK accepts an arbitrary `MediaStream` (e.g. `canvas.captureStream(30)`) as the outgoing camera
[raw media](https://learn.microsoft.com/en-us/azure/communication-services/quickstarts/voice-video-calling/get-started-raw-media-access?pivots=platform-web),
exposes each remote participant's incoming video as a `MediaStream` (`remoteVideoStream.getMediaStream()`),
and has a GA **DataChannel** for arbitrary binary messages between participants
[data channel](https://learn.microsoft.com/en-us/azure/communication-services/concepts/voice-video-calling/data-channel).
That is exactly the three primitives hopeOS needs: send our composited holohand frame as "camera", read
other tiles' frames for local tracking, and sync ball state.

The same code joins a **plain ACS group call** (`callAgent.join({ groupId: '<GUID>' })`) with no Teams
tenant at all
[manage-calls](https://learn.microsoft.com/en-us/azure/communication-services/how-tos/calling-sdk/manage-calls?pivots=platform-web#join-a-group-call),
so the three-laptop ball game can be built and measured before any tenant question is answered.

## 2. Azure resource setup (10 minutes, needs an Azure subscription)

1. Create a resource group first (the portal cannot create both at once).
2. Portal: **Create a resource → "Communication Services"**, pick subscription, resource group, name and the
   **data location** (geography, e.g. United States). Or CLI:
   `az communication create --name "<acsResourceName>" --location "Global" --data-location "United States" --resource-group "<rg>"`
   [create-communication-resource](https://learn.microsoft.com/en-us/azure/communication-services/quickstarts/create-communication-resource?pivots=platform-azp).
3. Resource → **Keys** → copy the **Connection string** (`endpoint=https://….communication.azure.com/;accesskey=…`) or
   `az communication list-key --name "<acsResourceName>" --resource-group "<rg>"`. Store it as
   `COMMUNICATION_SERVICES_CONNECTION_STRING` (Vercel project env var) — never in the browser
   [authentication](https://learn.microsoft.com/en-us/azure/communication-services/concepts/authentication).
4. Zero-code smoke test: resource → **Identities & User Access Tokens** blade → tick `voip` → **Generate**;
   paste the token into `acs-client.html`'s "paste a token" field
   [portal pivot](https://learn.microsoft.com/en-us/azure/communication-services/quickstarts/identity/access-tokens?pivots=platform-azportal).
5. Deploy `acs-token.js` as `api/acs-token.js` on Vercel with the env vars listed in its header; set
   `ACS_TOKEN_SHARED_SECRET` because every token you mint can generate billable minutes.

Token facts: scopes `voip` (calls) / `chat`; default lifetime 24 h, configurable 60–1440 min; the
client credential can auto-refresh via `tokenRefresher` + `refreshProactively`
[access-tokens JS](https://learn.microsoft.com/en-us/azure/communication-services/quickstarts/identity/access-tokens?pivots=programming-language-javascript),
[communication-common README](https://github.com/Azure/azure-sdk-for-js/blob/main/sdk/communication/communication-common/README.md).
Identity API limits: 1,000 `createUserAndToken` per 30 s per resource
[service-limits](https://learn.microsoft.com/en-us/azure/communication-services/concepts/service-limits#identity).

## 3. Loading the SDK without a bundler (what actually exists)

| Artifact | Format | Verified |
| --- | --- | --- |
| `@azure/communication-calling@1.46.1` (latest stable; `1.47.1-beta.1` is `next`) | `main: dist/sdk.bundle.js` = **UMD** with externals `@azure/logger` and `@azure/communication-common` (global name `azure-communication-calling`); `module: dist-esm/sdk.bundle.js` = **ESM** whose only bare imports are those same two packages. 8 files, ~7.3 MB each bundle. | package.json + first bytes of both bundles fetched from jsDelivr |
| `https://cdn.jsdelivr.net/npm/@azure/communication-calling@1.46.1/+esm` | jsDelivr-generated ESM, 6.8 MB, HTTP 200 | fetched |
| `@azure/communication-common@2.5.0` | true ESM with `exports.browser`, MIT; `/+esm` HTTP 200 | package.json fetched |
| `@azure/communication-calling-effects@1.3.2` | `exports.import: dist-esm/index.js` (background blur/replacement; GA on desktop Chrome/Edge/Safari) | package.json fetched |

There is **no cdnjs/UMD-standalone build**; Microsoft's docs only show webpack
[video quickstart](https://learn.microsoft.com/en-us/azure/communication-services/quickstarts/voice-video-calling/get-started-with-video-calling?pivots=platform-web).
`acs-client.html` therefore uses an **import map** pointing at Microsoft's own `dist-esm` file plus jsDelivr `+esm`
for the two small dependencies. I verified the URLs and module format, that the local copy of `dist-esm/sdk.bundle.js` really exports `CallClient`, `LocalVideoStream`, `VideoStreamRenderer`, `Features` and imports only the two mapped packages, and that the page's module script parses (`node --check`) — **not** a browser run against a live ACS resource; the first run is the test.
The Calling SDK is proprietary-licensed ("Microsoft Software License Terms…", LICENSE in the package); the common, identity
and UI-library packages are MIT.
(The one script-tag artifact that does exist is the UI Library's `callComposite.js` release bundle — React and the Calling SDK baked in,
`window.callComposite.loadCallComposite(...)` — useful as a stock-Teams-look oracle page, not as our media layer; see `UI-LIBRARY.md`.)

## 4. Teams tenant policy (what gates step 6/7 of the roadmap)

Anonymous join is **enabled by default**; ACS users are governed by the same settings as Teams-web anonymous users
[join-teams-meeting](https://learn.microsoft.com/en-us/azure/communication-services/concepts/join-teams-meeting#enabling-anonymous-meeting-join-in-your-teams-tenant).
Exact knobs, from [teams-administration](https://learn.microsoft.com/en-us/azure/communication-services/concepts/interop/guest/teams-administration):

| Setting (Teams admin center / PowerShell) | Object · property | Effect on us |
| --- | --- | --- |
| Anonymous users can join a meeting (org-wide) | `CsTeamsMeetingConfiguration.DisableAnonymousJoin` | if disabled, we cannot join at all |
| Let anonymous people join a meeting (per organizer) | `CsExternalAccessPolicy.EnableAcsFederationAccess` | same |
| Anonymous users can join a meeting (per organizer) | `CsTeamsMeetingPolicy.AllowAnonymousUsersToJoinMeeting` | same |
| Blocked anonymous join client types | `CsTeamsMeetingPolicy.BlockedAnonymousJoinClientTypes` = `ACS` | blocks specifically ACS clients |
| Let anonymous people start a meeting | `CsTeamsMeetingPolicy.AllowAnonymousUsersToStartMeeting` | whether we can be first in |
| Automatically admit people | `CsTeamsMeetingPolicy.AutoAdmittedUsers` / meeting option "Who can bypass the lobby" | `Everyone` → no lobby; otherwise we wait |
| Meeting options: attendee mic / camera | organizer setting | can stop our audio/video if we are attendees |

Lobby rule: "A Communication Service user won't be admitted to a Teams meeting until there is at least one Teams user
present in the meeting. Once a Teams user is present, then the Communication Services user will wait in the lobby until
explicitly admitted by a Teams user, unless the 'Who can bypass the lobby?' meeting policy/setting is set to 'Everyone'"
[join-teams-meeting](https://learn.microsoft.com/en-us/azure/communication-services/concepts/join-teams-meeting#meeting-experience).
The SDK reports this as `call.state === 'InLobby'`.
Meetings must be **Teams for Work** (`teams.microsoft.com` links); Teams for Home (`teams.live.com`), end-to-end-encrypted
meetings, town halls and live events are not joinable
[capabilities](https://learn.microsoft.com/en-us/azure/communication-services/concepts/interop/guest/meeting-capabilities).
A Teams user cannot join a call we started — the meeting has to be scheduled by a licensed Teams user (our Teams contact)
[join-teams-meeting](https://learn.microsoft.com/en-us/azure/communication-services/concepts/join-teams-meeting).

**Ask the Teams contacts:** (1) is `BlockedAnonymousJoinClientTypes` set to `ACS` on the pilot tenant; (2) will the organizer set
"Who can bypass the lobby" = Everyone for the demo meeting; (3) are attendee camera/mic enabled; (4) is the meeting E2EE (must be off).

## 5. Pricing (pay-as-you-go, no free tier for calling)

- **$0.004 per participant per minute** for every participant connected through ACS SDKs (audio, video, screen share and TURN are the same rate; billed to the millisecond). Lobby and hold time count
  [pricing](https://learn.microsoft.com/en-us/azure/communication-services/concepts/pricing),
  [teams-interop-pricing](https://learn.microsoft.com/en-us/azure/communication-services/concepts/pricing/teams-interop-pricing).
- Participants on Teams desktop/web/mobile clients: **$0** (covered by the organizer's license). "There's no additional fee for the interoperability capability itself."
- Chat: $0.0008 per message sent by an ACS user; ACS call recording is not available inside Teams meetings.
- Worked numbers: 3 laptops × 60 min on our page = **$0.72**; 1 on our page + 2 on Teams = $0.24; a 20-hour test week with 3 browsers ≈ $14.

## 6. Limits that shape the twin

| Limit | Value | Source |
| --- | --- | --- |
| Participants | 350 per ACS call (Teams meetings hold 1,000 but the SDK caps at 350); chat 250 | [calling-sdk-features](https://learn.microsoft.com/en-us/azure/communication-services/concepts/voice-video-calling/calling-sdk-features#number-of-participants-on-a-call-support), [join-teams-meeting](https://learn.microsoft.com/en-us/azure/communication-services/concepts/join-teams-meeting#limitations-and-known-issues) |
| Outgoing streams (web) | 1 video + 1 screen share | [calling-sdk-features](https://learn.microsoft.com/en-us/azure/communication-services/concepts/voice-video-calling/calling-sdk-features#supported-number-of-incoming-video-streams) |
| Incoming video rendered (web) | 16 + 1 screen share on desktop (GA); **25** (5×5) on desktop with SDK ≥ 1.40.0; **4** + 1 on mobile browsers. 16 needs 16 GB RAM / 4 cores; 25 needs 8 cores. The older service-limits page still says 9 — trust the SDK overview (updated 2026-03). | same, [optimizing-video-placement](https://learn.microsoft.com/en-us/azure/communication-services/quickstarts/voice-video-calling/optimizing-video-placement) |
| Incoming resolution ladder | 1 stream → 1080p, 2 → 720p, **3 → 540p**, 4–9 → 360p, 10–16 → 240p, 17–25 → 180p; max two 720p tiles at once | [optimizing-video-placement](https://learn.microsoft.com/en-us/azure/communication-services/quickstarts/voice-video-calling/optimizing-video-placement#how-many-videos-to-place-in-a-grid-at-a-time) |
| Outgoing resolution | 720p default on desktop, 1080p opt-in via video constraints (SDK ≥ 1.34.1); 720p on mobile | [calling-sdk-features](https://learn.microsoft.com/en-us/azure/communication-services/concepts/voice-video-calling/calling-sdk-features#supported-video-resolutions) |
| Call duration | 30 h max | [calling-sdk-features](https://learn.microsoft.com/en-us/azure/communication-services/concepts/voice-video-calling/calling-sdk-features#maximum-call-duration) |
| Mute/unmute | throttled above 15 toggles per 30 s | [known-issues](https://learn.microsoft.com/en-us/azure/communication-services/concepts/known-issues#excessive-use-of-certain-apis-like-muteunmute-results-in-throttling-on-azure-communication-services-infrastructure) |
| DataChannel | 32 KB/msg; ≤ 64 listed recipients (empty = broadcast); Durable 64 kbps, Lossy 512 kbps, High-priority Lossy 200 kbps; broadcast ≤ 80 packets/s; receiver closes after 2 min idle; GA in 1.20.1 | [data-channel](https://learn.microsoft.com/en-us/azure/communication-services/concepts/voice-video-calling/data-channel#limitations), [release notes 1.20.1](https://github.com/Azure/Communication/blob/master/releasenotes/acs-javascript-calling-library-release-notes.md) |
| Token TTL | 60–1440 min | [access-tokens](https://learn.microsoft.com/en-us/azure/communication-services/quickstarts/identity/access-tokens?pivots=programming-language-javascript#set-a-custom-token-expiration-time) |

Consequence for the ball game: with three tiles each remote video arrives at ~540p; tracking hands from *received* video
is possible (`getMediaStream()`) but the intended design — each browser tracks itself and ships 21×3 landmarks over the
DataChannel (~1 KB/packet, well inside 512 kbps Lossy) — is both lower latency and resolution-independent.

## 7. Browser support and Safari caveats

Supported (last three major versions): Windows Chrome/Edge/Firefox(**preview**)/Electron; macOS Chrome/Safari/Edge/Firefox/Electron;
iOS Safari/Chrome/Edge + WKWebView(preview); Android Chrome/Edge + system WebView; Linux Chrome only. Outgoing screen share is desktop-only.
[calling-sdk-features](https://learn.microsoft.com/en-us/azure/communication-services/concepts/voice-video-calling/calling-sdk-features#javascript-calling-sdk-support-by-os-and-browser).
Safari specifics: cannot enumerate/select speakers (macOS + iOS); iOS Safari drops Bluetooth mics, may **reload the page** when the user
switches apps, resets device permissions unless a stream is held (call `askDevicePermission()` before enumerating); using your own
`getUserMedia` during a call can lose call audio on iOS Safari; `ctx.filter` is unsupported in Safari canvas; background effects are desktop-only
[known-issues](https://learn.microsoft.com/en-us/azure/communication-services/concepts/known-issues),
[raw media](https://learn.microsoft.com/en-us/azure/communication-services/quickstarts/voice-video-calling/get-started-raw-media-access?pivots=platform-web).
`canvas.captureStream()` itself is Baseline in all four engines since 2020
[MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream).
Iframes need `allow="camera *; microphone *"`; WebRTC needs https (localhost ok).

## 8. What does NOT work for us as an external (ACS) user in a Teams meeting

From the [capabilities table](https://learn.microsoft.com/en-us/azure/communication-services/concepts/interop/guest/meeting-capabilities) and
[join-teams-meeting](https://learn.microsoft.com/en-us/azure/communication-services/concepts/join-teams-meeting#limitations-and-known-issues):

- Cannot join Teams for Home meetings, E2EE meetings, webinars/town halls/live events; channel meetings work for A/V but no chat.
- No breakout rooms, no Large-gallery view, cannot change meeting options, cannot manage Teams recording/transcription (we only get told it is on and must show a banner — a contractual obligation).
- **Explicit consent gate (verified in the 1.46.1 typings):** `RecordingCallFeature` and `TranscriptionCallFeature` both carry `isTeamsConsentRequired` and `grantTeamsConsent()`; when the organizer's tenant requires explicit consent, our audio, video and screen share are not sent until we grant it. `acs-client.html` shows a "Grant consent" button whenever either flag is true — without it the canvas would silently stop reaching the Teams gallery.
- No Teams background images, no watermark, no polls/Q&A/Whiteboard/Excel Live, no "give/request control" on screen share, only Content-only screen-share receive.
- Chat only during the meeting; no file send, reply, react.
- Not included in Graph `listParticipants`; no Event Grid call events; we appear as "Anonymous" in Teams Call Analytics.
- Docs disagree on captions and reactions (capabilities table ✔️, older concept page ❌) — test, do not assume.
- **DataChannel inside a Teams meeting is undocumented** (absent from the capabilities table). Teams-native clients cannot receive it regardless. Test it in group-call mode, then in a real meeting; the roadmap's WebSocket relay is the fallback.
- Video effects: only Microsoft's blur/replacement effects exist; our compositing happens before the SDK anyway.

## 9. Status flags (beta / preview / paid / gated)

- GA: Teams meeting join by link and by meeting ID + passcode (SDK ≥ 1.17.1), raw media in/out (≥ 1.13.1), DataChannel (≥ 1.20.1), video constraints, 25-tile grid (≥ 1.40.0), background effects on desktop.
- Public preview: Firefox desktop, iOS WKWebView, raw screen-share access (≥ 1.15.1-beta.1), mute-others, two-camera send (1.17.1-beta.1), identity `customId` (identity SDK 1.4.0-beta1), join by "meeting coordinates" (limited preview).
- Tenant-gated: everything in section 4; Teams Premium only affects organizer-side features (templates, custom backgrounds) we cannot consume anyway.
- Paid: $0.004/participant-minute for our side; Azure subscription required. Teams side free.

## 10. How this plugs into the roadmap

Step 3 (transport pick): run `acs-client.html` in **group-call mode** on two laptops — it exercises the same video path and DataChannel we would use in Teams, with the latency HUD from step 1 measuring canvas→remote-tile age.
Step 7 (join a Teams meeting): switch the mode selector to the meeting link; nothing else changes. The tenant questions in section 4 are the only external dependency.
The twin page can host both: our own gallery/toolbar/side-pane (see `UI-LIBRARY.md` for the Fluent tokens and layout constants to imitate) with `acs-client.html`'s module as the media/session layer.
