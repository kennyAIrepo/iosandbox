# ACS UI Library (`@azure/communication-react`) — what it is and what the Teams twin can take from it

Repo: https://github.com/Azure/communication-ui-library · Storybook: https://azure.github.io/communication-ui-library ·
Learn overview: https://learn.microsoft.com/en-us/azure/communication-services/concepts/ui-library/ui-library-overview
Local copies of every source cited below live in `_src/ui_*` (CallComposite.tsx, CallArrangement.tsx, VideoGallery.tsx, VideoTile.tsx,
ControlBar.tsx, themes.ts, AzureCommunicationCallAdapter.ts, callCompositeLoader.ts, javascript-loaders.ts, JavaScriptBundle_Docs.mdx, LICENSE.md).

## Facts

| Question | Answer | Evidence |
| --- | --- | --- |
| License | **MIT** ("MIT License / Copyright (c) Microsoft Corporation") | [LICENSE.md](https://raw.githubusercontent.com/Azure/communication-ui-library/main/LICENSE.md) |
| React-only? | **Yes.** README: "A React library offering UI components…". `peerDependencies`: `react` and `react-dom` `>=16.8.0 <19.0.0` (React 19 not supported yet). Depends on Fluent UI v8 (`@fluentui/react ^8.123.0`) **and** v9 (`@fluentui/react-components 9.62.0`). Peer `@azure/communication-calling 1.41.1-beta.1 || ^1.40.1`. | [package.json on main](https://raw.githubusercontent.com/Azure/communication-ui-library/main/packages/communication-react/package.json) (version `1.35.0-beta.0` on main; jsDelivr's `latest` resolved to 1.34.0) |
| CDN / UMD build? | **No npm/CDN one** — `main` = CJS, `module` = ESM, no `browser`/`unpkg` field; jsDelivr's synthesized `…/@azure/communication-react/+esm` (HTTP 200, 2.7 MB) still needs React/ReactDOM/Fluent peers — untested. **BUT (correction to the first pass):** Microsoft publishes prebuilt, React-included script bundles on GitHub Releases — `https://github.com/Azure/communication-ui-library/releases/latest/download/callComposite.js` (also `chatComposite.js`, `callWithChatComposite.js`). A plain `<script src>` exposes `window.callComposite.loadCallComposite(args, containerEl, props)`, built from `samples/StaticHtmlComposites` (`rush build`). Docs say it is for "development and prototyping"; production should self-host. Not executed here. Two arg shapes are in the sources: the storybook doc shows `{ locator, displayName, userId, token }`, the current loader (`_src/ui_callCompositeLoader.ts`) takes `{ userId, credential, displayName, locator, callAdapterOptions?, callCompositeOptions?, formFactor? }` and mounts via `createRoot` — check which the downloaded bundle expects (`Object.keys`/error message) on first run. | `_src/ui_JavaScriptBundle_Docs.mdx`, `_src/ui_javascript-loaders.ts`, `_src/ui_callCompositeLoader.ts` |
| Three layers | **Composites** (turn-key pages), **UI Components** (VideoGallery, VideoTile, GridLayout, ControlBar, ParticipantList…), **Stateful clients** (`StatefulCallClient`, framework-agnostic state on top of the Calling SDK) | [Learn overview](https://learn.microsoft.com/en-us/azure/communication-services/concepts/ui-library/ui-library-overview) |
| Composites | `CallComposite`, `ChatComposite`, `CallWithChatComposite` — "It includes support for Teams Interop"; CallComposite has a lobby page for Teams. | same |
| Design kit | The same components exist as a **Figma community file** (1095841357293210472) — the fastest way to get pixel-accurate Teams-like tiles/bars into our mockups. | same |
| Telemetry | README carries a data-collection notice: "The software may collect information about you and your use of the software and send it to Microsoft." | [README](https://raw.githubusercontent.com/Azure/communication-ui-library/main/README.md) |
| Teams meeting join | `CallAdapterLocator = TeamsMeetingLinkLocator \| GroupCallLocator \| RoomCallLocator \| CallParticipantsLocator \| TeamsMeetingIdLocator`; `createAzureCommunicationCallAdapter({ userId, displayName, credential, locator, options })`; `createAzureCommunicationCallAdapterFromClient(statefulCallClient, callAgent, locator)` lets you keep your own client; `useAzureCommunicationCallAdapter` hook. | [AzureCommunicationCallAdapter.ts](https://raw.githubusercontent.com/Azure/communication-ui-library/main/packages/react-composites/src/composites/CallComposite/adapter/AzureCommunicationCallAdapter.ts) |

## How the CallComposite is built (this is the Teams-look we are cloning)

Source: [CallComposite.tsx](https://raw.githubusercontent.com/Azure/communication-ui-library/main/packages/react-composites/src/composites/CallComposite/CallComposite.tsx),
[CallArrangement.tsx](https://raw.githubusercontent.com/Azure/communication-ui-library/main/packages/react-composites/src/composites/CallComposite/components/CallArrangement.tsx),
[CallPage.styles.ts](https://raw.githubusercontent.com/Azure/communication-ui-library/main/packages/react-composites/src/composites/CallComposite/styles/CallPage.styles.ts).

```
CallComposite({ adapter, formFactor: 'desktop'|'mobile', callInvitationUrl?, options })
└─ BaseProvider (FluentThemeProvider + icons + locale)
   └─ CallAdapterProvider
      └─ MainScreen — page switch on adapter state:
           'configuration' (ConfigurationPage: name, device pickers, preview)
           'lobby'         (LobbyPage: "waiting to be admitted" — Teams interop)
           'call'          (CallPage → CallArrangement)
           'hold' | 'transferring' | 'leftCall' | 'leaving' | 'badRequest' | 'removedFromCall' | 'joinCallFailedDueToNoNetwork'
```

`CallArrangement` (desktop) is a Fluent `Stack`:

```
┌ containerStyleDesktop: width 100%, min-width 30rem, min-height 13rem ───────────────────────┐
│ NotificationStack  (absolute overlay at top, pointer-events: none)                          │
│ ┌───────────────────────────────────────────────┬──────────────────────────┐                │
│ │ VideoGallery  (galleryParentContainerStyles,   │ SidePane (right, fixed   │                │
│ │  background = theme.palette.neutralLighterAlt) │  width; people / chat /  │                │
│ │  CaptionsBanner below the gallery              │  video-effects pane,     │                │
│ │                                                │  VIDEO_EFFECTS_SIDE_PANE_WIDTH_REM)        │
│ └───────────────────────────────────────────────┴──────────────────────────┘                │
│ ControlBar docked at the bottom (CONTROL_BAR_Z_INDEX = VIDEO_GALLERY_Z_INDEX + 1)           │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
mobile: min-width 17.5rem; side pane replaces the gallery; "More" drawer (DRAWER_Z_INDEX);
        draggable local+remote PIP (ModalLocalAndRemotePIP) while a pane is open;
        landscape → vertical control bar.
```

`CallCompositeOptions` worth copying as *our* option surface: `callControls` (bool or per-button config), `galleryOptions.layout`,
`localVideoTile: 'grid' | 'floating'`, `remoteVideoTileMenuOptions`, `branding.logo / backgroundImage`, `surveyOptions`,
`spotlight.hideSpotlightButtons`, `joinCallOptions.microphoneCheck: 'requireMicrophoneAvailable' | 'skip'`, `notificationOptions`.

### VideoGallery ([source](https://raw.githubusercontent.com/Azure/communication-ui-library/main/packages/react-components/src/components/VideoGallery.tsx))

- `layout: 'default' | 'floatingLocalVideo' | 'speaker' | 'largeGallery' | 'togetherMode' | 'focusedContent'` (one sub-layout component each).
- `DEFAULT_MAX_REMOTE_VIDEO_STREAMS = 4` (`maxRemoteVideoStreams` prop) — the library itself renders only 4 remote videos by default and puts the rest in an overflow strip: `overflowGalleryPosition: 'horizontalBottom' (default) | 'verticalRight' | 'horizontalTop'`.
- Pin up to 4 participants (`pinnedParticipants`, `onPinParticipant`), spotlight (`spotlightedParticipants`), `localVideoTileSize: '9:16' | '16:9' | 'hidden' | 'followDeviceOrientation'`, `localVideoViewOptions` / `remoteVideoViewOptions` (scaling/mirroring).

### VideoTile ([source](https://raw.githubusercontent.com/Azure/communication-ui-library/main/packages/react-components/src/components/VideoTile.tsx))

Props to mirror in our tile: `displayName`, `renderElement` (the `<video>` from `VideoStreamRenderer`), `isMuted`, `isSpeaking` (border highlight),
`raisedHand`, `isSpotlighted`, `isPinned`, `showLabel`, `showMuteIndicator`, `isMirrored`, `overlay` (reactions), `contextualMenu`,
`onRenderPlaceholder` (Persona avatar when no video), `participantState`, `mediaAccess`.

### ControlBar ([source](https://raw.githubusercontent.com/Azure/communication-ui-library/main/packages/react-components/src/components/ControlBar.tsx))

`layout: 'horizontal' | 'vertical' | 'dockedTop' | 'dockedBottom' | 'dockedLeft' | 'dockedRight' | 'floatingTop' | 'floatingBottom' | 'floatingLeft' | 'floatingRight'`
(default horizontal; floating variants add shadow + radius; theme-aware background). Buttons are `ControlBarButton` instances such as `CameraButton`
(the storybook also documents microphone / end-call / screen-share / participants / devices buttons; only `CameraButton` is named in the source comment I read).

### Side pane ([common/](https://api.github.com/repos/Azure/communication-ui-library/contents/packages/react-composites/src/composites/common))

`SidePaneHeader.tsx`, `PeoplePaneContent.tsx`, `VideoEffectsPane.tsx`, `AddPeopleButton/Dropdown`, `Drawer/`, `MoreButton.tsx`, `CallingCaptionsBanner.tsx`,
`Survey.tsx`/`StarSurvey.tsx` (post-call rating), `ModalLocalAndRemotePIP.tsx`.

### Theme tokens ([themes.ts](https://raw.githubusercontent.com/Azure/communication-ui-library/main/packages/react-components/src/theming/themes.ts), Fluent v8 `createTheme`)

| Token | light | dark |
| --- | --- | --- |
| `themePrimary` | `#0078d4` | `#2899f5` |
| `themeDark` | – | `#59b0f7` |
| `neutralPrimary` (text) | `#323130` | `#ffffff` |
| `neutralLighter` | `#f3f2f1` | `#383735` |
| `white` (surface) | `#ffffff` | `#252423` |
| `black` | `#000000` | – |
| `callingPalette.callRed` (end-call) | `#a42e43` | `#c4314b` |
| `callingPalette.raiseHandGold` | `#eaa300` | `#eaa300` |
| `callingPalette.iconWhite` | `#ffffff` | – |

`acs-client.html` already uses the dark set.

## Recommendation for the twin (hopeOS is vanilla ES modules, no React)

1. **Imitate, don't import.** Copy the structure (notification overlay → gallery → captions → docked control bar, right side pane, lobby page)
   and the tokens above into our own CSS. MIT allows it; attribution in a comment is polite. The Figma design kit gives us the exact
   tile/bar geometry. Keep the library's *behaviours* that users expect: speaking border, mute badge, `default` 4-remote-video cap + overflow strip,
   floating local tile, lobby state page.
2. **Do not put React in the twin's runtime.** Peer React < 19, Fluent v8 + v9, ~2.7 MB ESM before peers, and telemetry — none of it buys us
   anything our vanilla gallery cannot do with `VideoStreamRenderer.createView()` output.
3. **Do build one reference page with the real `CallComposite`** as a regression oracle: if our vanilla page fails to join a meeting but the
   composite succeeds on the same token, the bug is ours, not tenant policy. Cheapest form (no Vite, no React project): one HTML file with
   `<script src="https://github.com/Azure/communication-ui-library/releases/latest/download/callComposite.js">` and
   `callComposite.loadCallComposite({ userId: { communicationUserId }, credential/token, displayName, locator: { meetingLink } }, el)` —
   React is inside that bundle, the host page stays vanilla. Fall back to Vite + React 18 only if the release bundle's loader signature
   fights us. This is also the zero-code path Microsoft points to for Teams-join testing
   ([guest overview → "Low code"](https://learn.microsoft.com/en-us/azure/communication-services/concepts/interop/guest/overview)).
4. If we ever want the composite *inside* the twin (e.g. to show "stock Teams-ish" vs "hopeOS layer" side by side), mount it as an isolated React island
   via `createAzureCommunicationCallAdapterFromClient` so both islands share one `CallAgent` — the SDK allows only one active call per agent anyway.
