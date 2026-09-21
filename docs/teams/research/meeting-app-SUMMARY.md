# SUMMARY - Teams meeting extension apps (side panel + share-to-stage) with Live Share, and the 2026 sideloading path

Researcher folder: `meeting-app`. Researched 2026-09-18; finished (merge of two passes + verification) 2026-09-18.
This is container **D** of the pilot memo (meeting-stage app + Live Share): the Teams-side shell that carries the ~600 B / 30 Hz landmark packets between participants and publishes the ball-pass result. Nothing here touches `C:\Users\hanna\iosandbox`.

## What the topic concluded

A meeting extension for the cross-tile ball game is a **configurable tab** whose manifest (schema v1.30, latest as of Aug 2026) lists `meetingSidePanel` + `meetingStage` contexts plus four delegated RSC permissions (`MeetingStage.Write.Chat`, `ChannelMeetingStage.Write.Group`, `LiveShareSession.ReadWrite.Chat`, `LiveShareSession.ReadWrite.Group`); `supportsCustomShareToStage` and `supportsAnonymousGuestUsers` live under `meetingExtensionDefinition`, not under the tab (which is `additionalProperties: false`). The side panel (280 px iframe) gates a "Play together" button with `meeting.getAppContentStageSharingCapabilities` (true only for presenters/organizers and only if the manifest has `meetingStage`) and calls `meeting.shareAppContentToStage(cb, url, {sharingProtocol: Collaborative})` to put `stage.html` on everyone's stage; `stopSharingAppContentToStage` is documented on Learn but `@hidden` in TeamsJS source, so the panel feature-detects it.

The stage joins one Fluid container per meeting via `new LiveShareClient(LiveShareHost.create()).joinContainer(schema)` and uses three primitives with distinct semantics:

| Primitive | Transport | Used for |
| --- | --- | --- |
| `LiveEvent` | Fluid **signal** (`runtime.submitSignal`) - not persisted, not ordered, not guaranteed, queued while disconnected, carries a host-synchronised timestamp | the 30 Hz hand-landmark packet `{seq, tile, hand}`, latest-wins with `seq` gap counting |
| `LivePresence` | Live Share presence, flips offline <= 20 s after disconnect | roster / tile assignment |
| `LiveState` | Live Share state with late-joiner re-sync + `allowedRoles`; `set()` returns a Promise and throws on role denial | ball ownership `{owner, goal, n}` - the RESULT of the local doctrine pickup/release, never a pinch/jointsWithin test |

`joinContainer()` returns `{container, services, timestampProvider, created}`; receiver `timestampProvider.getTimestamp() - evt.timestamp` gives one-way age on a common clock, which is what the stage HUD (hz / p50 / p95 / max / lost per sender) measures. Microsoft's only rate guidance is ">= 50 ms between messages" (20 Hz) with no enforced limit and N^2 signal fan-out (PR #795 targeted signals exists; which published version exposes it is unknown); the stage sends at 30 Hz with a 20/15/10 Hz toggle to find the knee. 100 attendees per session; hosted relay data kept < 24 h; `initialObjects` frozen once the container exists.

Package reality: `@microsoft/live-share` latest is **1.4.2** (Jan 2024), CommonJS-only on Fluid 1.x peers; the 2.0 line is only `2.0.0-internal.18` (ESM, Fluid 2.40-2.120), issue #741 still open, repo alive (main commit 2026-04-02; a guest-sync service regression was fixed July 2025). Bundler-free works for TeamsJS (UMD `res.cdn.office.net/teams-js/2.56.0/js/MicrosoftTeams.min.js`, verified) and *with a caveat* for Live Share via `https://esm.sh/@microsoft/live-share@1.4.2` (module verified to be produced; a Teams session through it is NOT verified). Local dev needs no tenant: `npx tinylicious@latest` on :7070 + `TestLiveShareHost.create()` (all roles, container id in URL hash).

Sideloading in 2026 is mechanically unchanged (admin: app setup policy *Upload custom apps* + org-wide *Let users interact with custom apps in preview*, up to 24 h; then Teams client upload / `atk install` / Developer Portal), but the **free M365 Developer Program E5 sandbox is gated** (VS Pro/Enterprise subscribers, ISV Success / MAICPP tiers, Premier/Unified Support) with a mandatory billing-account link; alternatives are a paid Business Basic tenant (~USD 6.5-8.4/user/month after the 2026-07-01 pricing change) or the pilot partner's tenant. Client gates: Teams **web** needs Public preview per participant for side panel/stage; **anonymous** participants cannot see/interact with stage apps (guests/external can, external only in scheduled meetings); Teams Rooms excluded; only presenters/organizers share. HTTPS is mandatory: `devtunnel host -p 3000 --allow-anonymous` (persistent tunnel to keep `validDomains` stable) or ngrok.

## Decisions that constrain design

1. Never track the Teams video tile; each client tracks locally and relays landmarks - the stage is only a transport + HUD + ownership publisher (memo decision, container D).
2. Pose stream = `LiveEvent` (lossy, `seq`-tagged, latest-wins). Ball ownership = `LiveState`. Persistent score (if ever) = `SharedMap` (ordered op, slower). Never carry ownership on `LiveEvent`.
3. Ownership writes come only from the local PROP COLLISION DOCTRINE (finger wrap / clip / holding-pose cradle; open hand = release) via `window.hopeos.claimBall()/passBall(tile)`; the stage never decides a grab itself.
4. Send raw 21-landmark hands; chirality/z-sign is measured by `hand-views.js _zSign` on every receiver, never sent or hard-coded.
5. 30 Hz exceeds Microsoft's 20 Hz guidance by design; measure with the HUD before committing the game loop; quantise to int16+base64 (~250 B) if loss climbs with size.
6. `initialObjects` (`packets`, `presence`, `ball`) is frozen per container - changing it means a new meeting / cleared `#containerId`.
7. Pilot targets **new Teams desktop**; browser participants must enable Public preview; every player needs a tenant identity (no anonymous join links).
8. Ship path is npm + Vite/webpack (dice-roller sample layout); the esm.sh import is sandbox-only.
9. `supportsAnonymousGuestUsers: true` in the canonical manifest is an *experiment* whose effect on stage apps is undocumented - flip to `false` if the pilot admin objects.
10. Manifest re-upload per `validDomains` change; tab content cached 24-48 h, so use version query strings while iterating.

## Canonical files (this folder)

- `manifest.json` - v1.30 meeting app manifest, app version 0.2.0; `meetingSidePanel`+`meetingStage`, four RSC permissions, `devicePermissions: ["media"]`, `supportsCustomShareToStage: true`, `supportsAnonymousGuestUsers: true` (experiment); placeholders `${{TAB_DOMAIN}}` and `id`. Needs `color.png`/`outline.png` in the zip.
- `config.html` - required tab configuration page (`pages.config.setValidityState/registerOnSaveHandler/setConfig`), sets `contentUrl` = `side-panel.html`; handles `default|dark|contrast` themes.
- `side-panel.html` - in-meeting side panel: capability-gated "Play together", `shareAppContentToStage`, `getAppContentStageSharingState` polling, feature-detected stop; forwards to `stage.html` when loaded on the stage via the native share fallback.
- `stage.html` - stage page: TeamsJS + Live Share join (`TestLiveShareHost` fallback with `?inTeams=0`), `LiveEvent` 30/20/15/10 Hz hand packet with age/loss HUD, `LivePresence` roster, `LiveState` ball owner + goal with Take/Pass buttons and `window.hopeos.feedHand/claimBall/passBall` hooks, camera probe.
- `README.md` - tenant options (A/B/C), admin steps, dev tunnel, manifest fill-in + zip, upload routes, meeting walkthrough, client caveats, who can play, camera in iframe, local run, admin-needed table.
- `NOTES.md` - LiveEvent transport facts, rate/size guidance, session limits, package versions + bundler-free options, tinylicious/local server, repo issues (#817, #803, #741, PR #795), TeamsJS meeting API details, side-panel/stage pixel sizes, ACS lane (`@microsoft/live-share-acs`).
- `verify-syntax.mjs` - offline check: parses every inline script (ESM for stage), validates manifest invariants, checks stage imports.
- `_src/` - cached primary sources (Live Share SDK .ts incl. `LiveState.ts`, TeamsJS `meeting.ts`/`index.ts`/`liveShareHost.ts`, npm + GitHub JSON, esm.sh output, CDN bundles, Learn capabilities page, official sample files).

### Merge record (canonical vs `research_draft1/meeting-app`)

- `side-panel.html`: byte-identical - kept canonical.
- `manifest.json`, `config.html`, `stage.html`: canonical is newer and a superset (0.2.0, LiveState ball ownership, doctrine hooks, contrast theme, `_src/` citations) - kept canonical.
- `README.md`, `NOTES.md`: canonical is newer (references LiveState + SUMMARY) - kept canonical.
- `SUMMARY.md`: existed only in the draft; rewritten here on top of it with the LiveState/doctrine/verification updates.

## Verification (run 2026-09-18)

`node --experimental-vm-modules verify-syntax.mjs` from this folder (Node v25.2.1): **all 18 checks passed** - config/side-panel classic scripts and the stage ESM script parse; all three pages load TeamsJS 2.56.0 UMD; manifest parses (manifestVersion 1.30, version 0.2.0) with both meeting contexts, both required RSC names, `supportsCustomShareToStage: true`, `media` device permission; stage imports `LiveShareClient`, `LiveEvent`, `LivePresence`, `LiveState`, `TestLiveShareHost`.
Not verified (needs network / a tenant): the esm.sh Live Share bundle actually joining a container; a real Teams session; measured one-way age at 30 Hz.

## Risks

- Browser-only participants need Public preview (and sideload permission) or they will not see the side panel/stage app.
- Anonymous join links are out; verify the pilot tenant allows guest/external participants.
- 30 Hz x N senders over Fluid signals exceeds the 20 Hz guidance; expect drops; keep ownership on LiveState.
- Live Share SDK sits on Fluid 1.x with no public 2.0 preview; plan a WebRTC data-channel fallback for the pose stream if the SDK stalls.
- esm.sh import path is unsupported by Microsoft; move to npm + bundler before the pilot.
- Hosted relay can regress (#817); tenant networks can block it (#803, 403 "Invalid token").
- Temporary dev tunnels rotate host names and force manifest re-uploads; devtunnel CLI is public preview.
- Tab content cached 24-48 h.
- Free developer sandbox may be unavailable; budget a paid tenant or depend on the partner admin.

## Open questions

- Effect of `supportsAnonymousGuestUsers: true` on stage-app visibility for anonymous vs guest users.
- Which published `@microsoft/live-share` version exposes targeted signals (PR #795).
- Pilot tenant: custom-app upload + Public preview for external testers; relay endpoints reachable.
- Measured age/loss at 30 Hz with three senders on the hosted relay.
- Camera prompt success inside the stage iframe on managed desktop clients.
- Live Share 2.0 public preview timing.

## Sources

Primary sources are cached under `_src/`; live URLs:

- https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/build-apps-for-teams-meeting-stage
- https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-apps-in-meetings
- https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/build-tabs-for-meeting
- https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/design/designing-apps-in-meetings
- https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-overview
- https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-capabilities
- https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-faq
- https://learn.microsoft.com/en-us/microsoft-365/extensibility/schema/ (root, root-configurable-tabs, root-authorization-permissions-resource-specific, root-meeting-extension-definition)
- https://developer.microsoft.com/json-schemas/teams/v1.30/MicrosoftTeams.schema.json
- https://learn.microsoft.com/en-us/javascript/api/@microsoft/teams-js/meeting , .../meeting.sharingprotocol , .../liveshare
- https://learn.microsoft.com/en-us/microsoftteams/platform/tabs/how-to/using-teams-client-library
- https://learn.microsoft.com/en-us/microsoftteams/platform/tabs/how-to/create-tab-pages/content-page , .../configuration-page
- https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/device-capabilities/browser-device-permissions
- https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/apps-upload
- https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/prepare-your-o365-tenant , .../teams-developer-portal
- https://learn.microsoft.com/en-us/microsoftteams/teams-custom-app-policies-and-settings
- https://learn.microsoft.com/en-us/microsoftteams/platform/resources/dev-preview/developer-preview-intro
- https://learn.microsoft.com/en-us/microsoftteams/platform/toolkit/agents-toolkit-fundamentals , .../microsoft-365-agents-toolkit-cli , .../debug-local
- https://learn.microsoft.com/en-us/office/developer-program/microsoft-365-developer-program , .../microsoft-365-developer-program-faq
- https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started , .../cli-commands
- https://www.microsoft.com/en-us/microsoft-365/business/microsoft-365-business-basic
- https://www.microsoft.com/en-us/licensing/news/2026-m365-packaging-pricing-updates
- https://github.com/OfficeDev/Microsoft-Teams-Samples/tree/main/samples/TeamsJS/meetings-stage-view/nodejs (manifest.json, Readme.md, server.js, ClientApp/package.json, app-in-meeting.jsx)
- https://github.com/microsoft/live-share-sdk (README, packages/live-share/README.md, src/LiveEvent.ts, LiveEventScope.ts, LivePresence.ts, LivePresenceUser.ts, LiveState.ts, LiveShareClient.ts, LiveShareRuntime.ts, LiveDataObject.ts, TestLiveShareHost.ts, interfaces.ts, index.ts; samples/javascript/01.dice-roller; packages/live-share-acs/README.md)
- https://github.com/microsoft/live-share-sdk/issues/817 , /issues/803 , /issues/741 , /pull/795
- https://api.github.com/repos/microsoft/live-share-sdk (+ /releases, /commits?sha=main)
- https://github.com/OfficeDev/microsoft-teams-library-js/blob/main/packages/teams-js/src/public/index.ts , .../meeting/meeting.ts , .../liveShareHost.ts
- https://registry.npmjs.org/@microsoft/live-share (+ /2.0.0-internal.18), https://registry.npmjs.org/@microsoft/teams-js/latest, https://registry.npmjs.org/@fluidframework/azure-local-service/latest, https://registry.npmjs.org/tinylicious/latest
- https://cdn.jsdelivr.net/npm/@microsoft/live-share/package.json , https://esm.sh/@microsoft/live-share@1.4.2
- https://res.cdn.office.net/teams-js/2.56.0/js/MicrosoftTeams.min.js (and 2.55.0)
- https://fluidframework.com/docs/concepts/signals/ , https://fluidframework.com/docs/testing/tinylicious/