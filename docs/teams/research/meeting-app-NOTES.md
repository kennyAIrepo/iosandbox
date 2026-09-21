# NOTES - Live Share transport facts, package reality, local server, known issues

Researched 2026-09-18 from Microsoft Learn, the `microsoft/live-share-sdk` repo, npm registry metadata and TeamsJS source. Primary sources are cached in `_src/` (SDK .ts files, TeamsJS meeting.ts, npm/GitHub JSON, the esm.sh output, the CDN bundle) - cite those before re-fetching.

## 1. How LiveEvent actually moves bytes (matters for a 30 Hz hand packet)

- `LiveEvent.send(evt)` -> `LiveEventScope.sendEvent()` -> `this._runtime.submitSignal(eventName, event)`. It is a **Fluid signal**, not an op. Received via `runtime.on("signal", ...)`. [LiveEventScope.ts](https://github.com/microsoft/live-share-sdk/blob/main/packages/live-share/src/LiveEventScope.ts)
- Fluid signals: "the information that is communicated via signals is not retained in the container" and "Signals are not guaranteed to be ordered on delivery relative to other signals and ops". Fluid recommends grouping several signal types into one combined signal to reduce network cost. [Fluid signals](https://fluidframework.com/docs/concepts/signals/)
- LiveEvent JSDoc: "Events aren't guaranteed to be delivered so you should limit their use to sending events you're ok with potentially being missed"; "The event will be queued for delivery if the client isn't currently connected"; register listeners before `initialize()`. [LiveEvent.ts](https://github.com/microsoft/live-share-sdk/blob/main/packages/live-share/src/LiveEvent.ts)
- Wire shape: `{ name, clientId, timestamp, data }` where `timestamp = liveRuntime.getTimestamp()` - the host-synchronised clock (`ILiveShareHost.getNtpTime`). Receiver signature: `on("received", (evt, local, clientId, timestamp) => ...)`. Role verification runs on send and on receive (`initialize(allowedRoles?)`). [LiveEventScope.ts], [interfaces.ts](https://github.com/microsoft/live-share-sdk/blob/main/packages/live-share/src/interfaces.ts)
- `joinContainer()` returns `{ container, services, timestampProvider, created }`; `timestampProvider.getTimestamp()` on the receiver minus the sender `timestamp` gives one-way age on a common clock (`getMaxTimestampError()` bounds the skew). [interfaces.ts]
- Consequence for the ball game: LiveEvent is right for the 30 Hz pose stream (lossy, latest-wins, add a `seq` and drop stale packets) and wrong for ball ownership (use `LiveState` - it re-syncs late joiners and has role checks) or persistent score (a `SharedMap`, which is an op and therefore ordered/persisted but slower). `stage.html` now does exactly this: `packets: LiveEvent`, `presence: LivePresence`, `ball: LiveState` (`{owner, goal, n}`); `LiveState.set(state)` returns a Promise and throws on role denial; `stateChanged(state, local, clientId, timestamp)` listeners must be registered before `initialize(initialState, allowedRoles?)` ([LiveState.ts](_src/LiveState.ts)). Ownership writes happen only from the local doctrine pickup/release (finger wrap / clip / cradle; open hand = release), never from a pinch or jointsWithin test.

## 2. Rate and size guidance

- Official: "there aren't any enforced limits, but ... debounce changes emitted through Live Share to one message per 50 milliseconds or more" (i.e. <= 20 Hz), "especially ... mouse or touch coordinates". Our 30 Hz test deliberately exceeds that by 1.5x; `stage.html` can toggle 30/20/15/10 Hz to find the knee. [Live Share FAQ](https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-faq)
- Signals fan out to every client: N senders x N receivers. PR #795 "Target signals to specific clients" (2024-08-30) exists "to reduce server load in large sessions by eliminating N^2 event distribution" - check which published package version exposes it before relying on it. [PR 795](https://github.com/microsoft/live-share-sdk/pull/795)
- `LiveShareClient` option `canSendBackgroundUpdates` (default true) controls background presence/state re-broadcasts; turn it off on the stage if you only want your own packets on the wire. [LiveShareClient.ts](https://github.com/microsoft/live-share-sdk/blob/main/packages/live-share/src/LiveShareClient.ts)
- No documented payload cap was found in Learn or the repo. Keep packets small anyway: 2 hands x 21 landmarks x 3 coords as rounded floats is ~1.2 KB JSON; quantise to int16 + base64 (~250 B) if the HUD shows loss climbing with size. [No primary source - engineering judgement]
- Presence: `LivePresence` state flips to `offline` up to 20 s after disconnect (`expirationPeriod` default 20 s). [LivePresence.ts](https://github.com/microsoft/live-share-sdk/blob/main/packages/live-share/src/LivePresence.ts), [Live Share capabilities](https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-capabilities)

## 3. Session limits and lifecycle

- Max 100 attendees per Live Share session. One Live Share container per meeting/chat/channel on the hosted relay (plus optionally your own Azure Fluid Relay container in parallel). Data on the hosted relay accessible up to 24 h, usually deleted within 6 h. [Live Share FAQ]
- `initialObjects` cannot change after the container exists. During dev: clear the `#containerId` hash locally, or start a new meeting in Teams. `dynamicObjectTypes` can be extended at any time. [Live Share FAQ]
- Supported meeting types: scheduled, 1:1 calls, group calls, meet now, channel meetings. Not Teams Rooms. GCC only (no GCC-High/DoD/21Vianet). Guests and external users supported except guests in channel meetings. [Live Share FAQ]
- Live Share objects require the Teams client SDK and "don't work outside Microsoft Teams" - except through `TestLiveShareHost` + tinylicious for local dev. [Live Share FAQ], [Live Share capabilities]

## 4. Package versions and the no-bundler question

| Package | Latest stable | Notes |
| --- | --- | --- |
| `@microsoft/live-share` | **1.4.2** (published 2024-01-18) | `main: ./bin/index.js` = CommonJS; no `module`, `exports` or `browser` fields. Peers: `fluid-framework ^1.2.3`, `@fluidframework/azure-client ^1.0.0`; dep `uuid ^9`. Tabs need `@microsoft/teams-js >= 2.23.0`. dist-tags: `latest 1.4.2`, `next 1.0.0-preview.15`, `internal 2.0.0-internal.18`. Sources: [registry](https://registry.npmjs.org/@microsoft/live-share), [jsdelivr package.json](https://cdn.jsdelivr.net/npm/@microsoft/live-share/package.json), [Live Share capabilities] |
| `@microsoft/live-share` 2.0 line | `2.0.0-internal.18` only | `type: module`, ships ESM (`bin/esm/index.public.js`) + CJS, peers `fluid-framework >=2.40 <2.120`. FAQ says Fluid 2 support is "in preview" via `2.0.0-preview.0 or later`, but no `2.0.0-preview.*` tag is published; issue #741 "Support Fluid Framework version 2" is still open. [registry 2.0.0-internal.18](https://registry.npmjs.org/@microsoft/live-share/2.0.0-internal.18), [issue 741](https://github.com/microsoft/live-share-sdk/issues/741) |
| `@microsoft/teams-js` | **2.56.0** | `main: dist/umd/MicrosoftTeams.min.js` (global `microsoftTeams`), `module: dist/esm/...`. Root exports include `LiveShareHost` and namespaces `app`, `pages`, `meeting`, `liveShare`. [registry](https://registry.npmjs.org/@microsoft/teams-js/latest), [index.ts](https://github.com/OfficeDev/microsoft-teams-library-js/blob/main/packages/teams-js/src/public/index.ts) |
| Repo health | not archived; last `main` commit 2026-04-02 (`pushed_at` 2026-09-15 on some branch); 20 open issues (81 counting PRs); releases page stops at v1.4.0 (2024-02-14) | [repo API](https://api.github.com/repos/microsoft/live-share-sdk), [commits](https://api.github.com/repos/microsoft/live-share-sdk/commits?per_page=10&sha=main) |
| Official meetings-stage-view sample | pins `@microsoft/live-share 1.0.0-preview.8`, `fluid-framework ~0.59`, `teams-js ^2.35`, React + CRA | stale as a Live Share reference; use `samples/javascript/01.dice-roller` (live-share 1.4.2, fluid 1.3.6, Vite 4) instead. [sample package.json](https://github.com/OfficeDev/Microsoft-Teams-Samples/blob/main/samples/TeamsJS/meetings-stage-view/nodejs/ClientApp/package.json), [dice-roller package.json](https://github.com/microsoft/live-share-sdk/blob/main/samples/javascript/01.dice-roller/package.json) |

**Bundler-free options**

- TeamsJS: `<script src="https://res.cdn.office.net/teams-js/2.56.0/js/MicrosoftTeams.min.js">` - Microsoft's documented CDN pattern; both the 2.55.0 and 2.56.0 URLs were fetched and return the UMD bundle defining `microsoftTeams`. The CDN build is not tree-shakable, which is irrelevant here. [content page](https://learn.microsoft.com/en-us/microsoftteams/platform/tabs/how-to/create-tab-pages/content-page), [TeamsJS library](https://learn.microsoft.com/en-us/microsoftteams/platform/tabs/how-to/using-teams-client-library)
- Live Share 1.4.2 is CJS-only, so it cannot be `import`ed from jsdelivr/unpkg directly. `https://esm.sh/@microsoft/live-share@1.4.2` was fetched and returns an ES module re-exporting `live-share.mjs` with `fluid-framework@^1.2.3`, `@fluidframework/azure-client@^1.0.0`, `@fluidframework/test-client-utils`, `uuid` and `buffer`/`events` polyfills resolved by esm.sh. **Verified only that the module is produced, not that a full Teams session works through it.** `stage.html` uses it with that caveat; the Microsoft-supported path is npm + Vite/webpack.
- Microsoft's own note: TeamsFx SDK is deprecated (community support until Sept 2026); Agents Toolkit / Agents SDK replace it. Not needed for a tab-only app. [TeamsJS library page]

## 5. Local Fluid server (what the samples actually run)

```json
{
  "scripts": {
    "start": "start-server-and-test start:server 7070 start:client",
    "start:client": "vite",
    "start:server": "npx tinylicious@latest"
  },
  "devDependencies": {
    "@fluidframework/test-client-utils": "^1.3.6",
    "start-server-and-test": "^2.0.0"
  }
}
```

- `npx tinylicious@latest` - in-memory Fluid service, default port 7070, `PORT` env var to change (`$env:PORT=6502` in PowerShell). [Tinylicious](https://fluidframework.com/docs/testing/tinylicious/), [Live Share capabilities]
- Alternative used by the official meetings-stage-view sample: `npx @fluidframework/azure-local-service@latest` (v3.1.0, wraps tinylicious ^7). [registry](https://registry.npmjs.org/@fluidframework/azure-local-service/latest)
- `TestLiveShareHost.create(getLocalTestContainerId?, setLocalTestContainerId?)` connects to `http://localhost:7070`, keeps the container id in the URL hash by default, returns roles organizer+presenter+attendee for everyone, and logs a "should only be used for local testing" warning. [TestLiveShareHost.ts](https://github.com/microsoft/live-share-sdk/blob/main/packages/live-share/src/TestLiveShareHost.ts)
- Dice-roller sample runbook: `npm install && npm run build:packages && cd samples/javascript/01.dice-roller && npm start` (starts tinylicious + Vite). [dice-roller README](https://github.com/microsoft/live-share-sdk/blob/main/samples/javascript/01.dice-roller/README.md)

## 6. Repo issues worth knowing (searched titles/bodies for throughput, latency, rate limit, ordering)

- No open or closed issue documents a hard rate limit or throttling of LiveEvent; the only throughput-related change is PR #795 (targeted signals). [search](https://api.github.com/search/issues?q=repo:microsoft/live-share-sdk+LiveEvent)
- **#817** "Anonymous/guest user edits/updates are not syncing correctly in Teams" (opened 2025-05-22): guests failed to join/sync with error 30104/30110; Microsoft (ryanbliss, 2025-07-09) confirmed a **service-side** fault, fixed without an SDK update. Shows guest support is intended, and that the hosted relay can regress underneath you. [issue 817](https://github.com/microsoft/live-share-sdk/issues/817)
- **#803** 403 "Invalid token validated with key2" from the relay for one tenant only; reporter suspected tenant-side network blocking. Worth a pre-check on the pilot tenant's network. [issue 803](https://github.com/microsoft/live-share-sdk/issues/803)
- **#741** Fluid Framework 2 support still open; **#744** proposes using Fluid audience for LivePresence online/offline. [issues](https://api.github.com/search/issues?q=repo:microsoft/live-share-sdk+is:issue+is:open)

## 7. TeamsJS meeting API details that affect the code

- `meeting.shareAppContentToStage(callback, appContentUrl, shareOptions?)`; `shareOptions.sharingProtocol` is `SharingProtocol.Collaborative` (default) or `SharingProtocol.ScreenShare`. Usable only in `sidePanel` and `meetingStage` frame contexts. `appContentUrl` origin must be in `validDomains`. [meeting module](https://learn.microsoft.com/en-us/javascript/api/@microsoft/teams-js/meeting), [SharingProtocol](https://learn.microsoft.com/en-us/javascript/api/@microsoft/teams-js/meeting.sharingprotocol)
- `getAppContentStageSharingCapabilities` returns `doesAppHaveSharePermission` only if the manifest's tab `context` includes `meetingStage`. [meeting module]
- `stopSharingAppContentToStage(callback)` is documented on the Learn concept page (updated 2026-07-13) but is tagged `@hidden` in `meeting.ts`, so it is absent from the generated API reference; feature-detect before calling. [build-apps-for-teams-meeting-stage](https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/build-apps-for-teams-meeting-stage), [meeting.ts](https://github.com/OfficeDev/microsoft-teams-library-js/blob/main/packages/teams-js/src/public/meeting/meeting.ts)
- `meeting.getAuthenticationTokenForAnonymousUser` and `getMeetingDetailsVerbose` exist in source (not used here).
- `liveShare.isSupported()` tells you whether the host supports Live Share before calling `LiveShareHost.create()`; Live Share supports `meetingStage`, `sidePanel` and `content` frame contexts, and `content` only on desktop/web. [liveShare module](https://learn.microsoft.com/en-us/javascript/api/@microsoft/teams-js/liveshare), [Live Share overview](https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-overview)

## 8. Design numbers for the Teams-twin page

- In-meeting side panel iframe: **280 px** wide, 20 px padding, single column, vertical scroll only, dark theme default in meetings.
- Meeting stage without side panel: **994x678** default, min 792x382. With side panel: **918x540** default, min 472x382. The stage "reorients for all participants the same way".
- Custom share button text: "Share" or scenario text such as "Play together"; never "Present".
[Designing your meeting extension (2026-07-31)](https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/design/designing-apps-in-meetings)

## 9. Adjacent option for the ACS lane

`@microsoft/live-share-acs` (added 2024-05-06, "private developer preview", access approval required) provides `ACSTeamsLiveShareHost.create()` so an ACS web client that joined a Teams meeting can be in the same Live Share session as Teams participants. Install: `npm install @microsoft/live-share-acs @azure/communication-calling@next`. [live-share-acs README](https://github.com/microsoft/live-share-sdk/blob/main/packages/live-share-acs/README.md)
