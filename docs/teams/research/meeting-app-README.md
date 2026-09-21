# hopeOS Ball Pass - Teams meeting extension sandbox (side panel + share-to-stage + Live Share)

Researched 2026-09-18. Every step below cites the primary source it came from. Nothing here touches `C:\Users\hanna\iosandbox`.

## Files in this folder

| File | What it is |
| --- | --- |
| `manifest.json` | App manifest v1.30 (latest, Aug 2026) with `meetingSidePanel` + `meetingStage` contexts, the four RSC permissions for stage + Live Share, `devicePermissions: ["media"]`, `validDomains`, `meetingExtensionDefinition.supportsCustomShareToStage: true` and `supportsAnonymousGuestUsers: true` (the latter is an experiment - see step 7). App version 0.2.0. |
| `config.html` | Required tab configuration page (`configurationUrl`). Sets `contentUrl` to `side-panel.html`. |
| `side-panel.html` | In-meeting side panel. Gates the "Play together" button with `getAppContentStageSharingCapabilities`, shares `stage.html` with `shareAppContentToStage`, polls `getAppContentStageSharingState`, feature-detects `stopSharingAppContentToStage`. |
| `stage.html` | The stage page. TeamsJS + Live Share (`LiveShareClient.joinContainer`, `TestLiveShareHost` fallback outside Teams), a `LiveEvent` broadcasting a 30 Hz hand packet and measuring receive age with the host-synchronised clock, a `LivePresence` roster, a `LiveState` for ball ownership + goal tile (Take ball / Pass to next tile; `window.hopeos.claimBall/passBall` hooks for the doctrine pickup logic), a camera probe. |
| `NOTES.md` | Live Share transport/ordering/rate facts, package/bundler reality, tinylicious commands, known issues. |
| `SUMMARY.md` | Findings, decisions, canonical file list, verification result, sources. |
| `verify-syntax.mjs` | Extracts every inline script from the three pages and parses it with V8 (`node --experimental-vm-modules verify-syntax.mjs`); no network, no Teams. |
| `_src/` | Cached primary sources (Live Share SDK .ts, TeamsJS meeting.ts/index.ts, npm + GitHub JSON, esm.sh output, CDN bundle, Learn pages, official sample files). |

You still need two icons in the zip: `color.png` (192x192) and `outline.png` (32x32, transparent) - the manifest `icons` block references them.

## 0. Decide which tenant (the gating question in 2026)

Sideloading ("upload a custom app") is governed by policies in the **Teams admin center**, so you need a work/school (Entra) tenant where an admin turns it on. Options:

| Option | Reality in Sept 2026 | Cost / admin |
| --- | --- | --- |
| **A. Microsoft 365 Developer Program E5 sandbox** | Still exists and still provisions an *instant sandbox* (25 E5 seats, Teams sample data pack with **Upload custom apps enabled by default**), but it is **no longer open to everyone**. Eligibility is limited to (1) Visual Studio Professional/Enterprise standard subscribers, (2) ISV Success Program or eligible MAICPP partner tiers, (3) Premier/Unified Support customers via their Microsoft contact. Linking a Microsoft Customer Agreement billing account is mandatory during setup (no charge). Renews every 60-90 days on development activity; Microsoft may require recreation every 90 days. Not offered in GCC/GCC-High/DoD. Sources: [Developer Program FAQ (updated 2026-09-08)](https://learn.microsoft.com/en-us/office/developer-program/microsoft-365-developer-program-faq), [Program overview (2026-09-02)](https://learn.microsoft.com/en-us/office/developer-program/microsoft-365-developer-program), [Prepare your tenant](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/prepare-your-o365-tenant). | Free if eligible. You are your own admin. |
| **B. Buy a small tenant** | Microsoft's tenant-prep page lists Business **Basic**, Standard, E1/E3/E5, Developer and Education as valid plans and points to a 1-month free trial or purchase. Business Basic was listed at roughly USD 6.48-8.40/user/month depending on billing term in Sept 2026 search results; Microsoft changed commercial pricing on 2026-07-01, so read the live page. Three seats (admin + two testers) is enough for the three-tile game. Sources: [Prepare your tenant](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/prepare-your-o365-tenant), [Business Basic page](https://www.microsoft.com/en-us/microsoft-365/business/microsoft-365-business-basic), [2026 pricing update](https://www.microsoft.com/en-us/licensing/news/2026-m365-packaging-pricing-updates). | Paid monthly; you are your own admin. |
| **C. The Teams contacts' pilot tenant** | Most realistic for the actual pilot. Ask their admin for: an **app setup policy** with *Upload custom apps* ON assigned to your test users, and org-wide *Let users interact with custom apps in preview* ON. External participants from other tenants can still see and use the shared stage (see step 7). | Needs their Teams admin; up to 24 h propagation. |

Hybrid that works well: build and iterate on A or B, then hand the same zip to C's admin.

## 1. Admin: enable custom app upload (what you must ask for)

From [Manage custom app policies and settings (2026-04-14)](https://learn.microsoft.com/en-us/microsoftteams/teams-custom-app-policies-and-settings) and [Prepare your tenant](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/prepare-your-o365-tenant):

1. Teams admin center > **Teams apps > Setup policies > Global** (or a new policy assigned to named users) > toggle **Upload custom apps** ON > Save.
2. Teams admin center > **Teams apps > Manage apps > Actions > Org-wide app settings > Custom apps** > turn on **Let users install and use available apps by default** and **Let users interact with custom apps in preview**.
3. Wait: "It can take up to 24 hours for the custom app upload to be active."
4. Roles: Teams Administrator or Global Administrator. Team-level setting *Allow members to upload custom apps* only matters for team scope; meetings use groupChat scope.

Developer Program instant sandboxes skip this - the sample data pack enables the setting by default.

## 2. HTTPS tunnel for the static files

Teams loads tab content only over HTTPS. Our repo's dev server is HTTP-only; a tunnel terminates TLS in front of it.

**Dev tunnels (Microsoft, CLI is "public preview")** - [get started](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started), [CLI reference](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/cli-commands):

```powershell
winget install Microsoft.devtunnel
devtunnel user login                      # Entra ID, Microsoft or GitHub account; anonymous hosting is not supported
# serve this folder on :3000 (any static server; e.g. npx serve -l 3000 . )
devtunnel host -p 3000 --allow-anonymous  # temporary tunnel, deleted when the process exits
# persistent tunnel with a stable id (max --expiration 30d):
devtunnel create hopeos-stage -a
devtunnel port create hopeos-stage -p 3000 --protocol http
devtunnel host hopeos-stage
```

The host prints `Hosting port 3000 at https://<tunnelid>-3000.<region>.devtunnels.ms/`. `--allow-anonymous` is required: the Teams client of every other participant fetches your iframe without your devtunnel login. That also means anyone who guesses the id can reach your local server, so serve only the static folder. A temporary tunnel gets a new id every run, which means a new `validDomains` entry and a manifest re-upload - use the persistent tunnel.

**ngrok** (what the official sample README uses): `ngrok http 3000 --host-header="localhost:3000"` - [meetings-stage-view README](https://github.com/OfficeDev/Microsoft-Teams-Samples/blob/main/samples/TeamsJS/meetings-stage-view/nodejs/Readme.md).

Agents Toolkit's F5 flow starts a dev tunnel for you, but it is built around its own project layout (`m365agents.local.yml`); for a static three-file app the CLI above is simpler. [Debug locally](https://learn.microsoft.com/en-us/microsoftteams/platform/toolkit/debug-local).

## 3. Fill in the manifest and zip it

1. Replace every `${{TAB_DOMAIN}}` with the tunnel host **without scheme or port** (e.g. `abc123-3000.usw2.devtunnels.ms`). `validDomains` entries cannot contain `https://`. (`${{...}}` is the Agents Toolkit env-substitution syntax used by the official sample; for a manual upload substitute by hand.)
2. Set `id` to a fresh GUID (`[guid]::NewGuid()` in PowerShell). A tab app with no SSO/bot needs no Entra app registration; `webApplicationInfo` is only for SSO.
3. Put `manifest.json`, `color.png`, `outline.png` at the **root** of a zip (no folder inside the zip - Developer Portal rejects nested packages).
4. Optional validation: `npm i -g @microsoft/m365agentstoolkit-cli` then `atk validate --package-file appPackage.zip` ([Agents Toolkit CLI](https://learn.microsoft.com/en-us/microsoftteams/platform/toolkit/microsoft-365-agents-toolkit-cli)), or the store validator linked from [Upload your custom app](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/apps-upload).

Manifest facts used ([schema reference, v1.30 = latest, Aug 2026](https://learn.microsoft.com/en-us/microsoft-365/extensibility/schema/)):

- `configurableTabs[].context` allowed values: `personalTab, channelTab, privateChatTab, meetingChatTab, meetingDetailsTab, meetingSidePanel, meetingStage` (max 7). `configurationUrl` and `scopes` are required. [root.configurableTabs](https://learn.microsoft.com/en-us/microsoft-365/extensibility/schema/root-configurable-tabs)
- RSC names for stage + Live Share: `MeetingStage.Write.Chat`, `ChannelMeetingStage.Write.Group`, `LiveShareSession.ReadWrite.Chat`, `LiveShareSession.ReadWrite.Group`, all `type: "Delegated"`. [resourceSpecific](https://learn.microsoft.com/en-us/microsoft-365/extensibility/schema/root-authorization-permissions-resource-specific), [Live Share capabilities](https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-capabilities)
- `devicePermissions` enum: `geolocation, media, notifications, midi, openExternal`. [root](https://learn.microsoft.com/en-us/microsoft-365/extensibility/schema/root)
- `supportsCustomShareToStage` lives under `meetingExtensionDefinition` (not under configurableTabs, which is `additionalProperties: false`); it hides the native share button so users only see our "Play together". [meetingExtensionDefinition](https://learn.microsoft.com/en-us/microsoft-365/extensibility/schema/root-meeting-extension-definition), [Hide native share button](https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/build-apps-for-teams-meeting-stage)

## 4. Upload

Three equivalent routes ([Upload your custom app](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/apps-upload)):

- **Teams client**: **Apps > Manage your apps > Upload an app > Upload a custom app** > pick the zip > **Add** > choose the meeting/chat scope.
- **Agents Toolkit CLI**: `atk auth login m365` then `atk install --file-path appPackage.zip --scope Shared`. [CLI reference](https://learn.microsoft.com/en-us/microsoftteams/platform/toolkit/microsoft-365-agents-toolkit-cli)
- **Developer Portal** (https://dev.teams.microsoft.com): **Apps > Import app** > zip > then *Preview in Teams*. Requires a work account in the tenant. [Developer Portal](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/teams-developer-portal)

Code changes on your server show up without re-uploading; manifest changes need a re-upload. Tab content can be cached by Teams for 24-48 h - add a version query string to your URLs while iterating ([content page](https://learn.microsoft.com/en-us/microsoftteams/platform/tabs/how-to/create-tab-pages/content-page)).

## 5. Open it in a meeting

1. **Schedule** a meeting from the Teams calendar (apps are not supported in end-to-end-encrypted calls, instant channel meetings or shared-channel meetings). [Apps for Teams meetings](https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-apps-in-meetings)
2. Open the meeting details > **+** > find "hopeOS Ball Pass" > the config page appears > **Save**. Only an organizer/presenter can add apps.
3. Join the meeting. Click the app icon in the meeting toolbar - the side panel opens with `frameContext = sidePanel`.
4. Press **Play together**. Teams opens `stage.html` on the stage for everyone (collaborative protocol); each client joins the same Live Share container.
5. Watch the HUD on the stage: roster (LivePresence), per-sender packet age / loss (LiveEvent), and the ball owner (LiveState). Press **Take ball** on one client and **Pass to next tile**; every client, including one that joins late, shows the same owner.

## 6. Client support caveats (read before demoing)

- **New Teams desktop** (Windows/Mac) is the target. "Meeting apps (side panel and meeting stage) are supported in Teams desktop client."
- **Teams web client**: side panel + stage are "supported only when the developer preview is enabled" - each participant using the browser must turn on **Settings > About Teams > Early access > Public preview**, which is only offered to users allowed to upload custom apps. [build-tabs-for-meeting (2026-08-03)](https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/build-tabs-for-meeting), [Developer preview](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/dev-preview/developer-preview-intro)
- **Teams Rooms**: `meetingStage` apps can't be used in Teams Rooms clients, and Live Share does not support Teams Rooms devices. [build-tabs-for-meeting](https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/build-tabs-for-meeting), [Live Share FAQ](https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-faq)
- **Mobile**: stage view exists on mobile; Live Share works in meetings on iOS/Android but not outside meetings. Untested here.
- **ScreenShare protocol** (view-only variant): not supported on Mac, classic Teams, mobile, web, VDI. [build-apps-for-teams-meeting-stage](https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/build-apps-for-teams-meeting-stage)

## 7. Who can play (user types and roles)

From [build-apps-for-teams-meeting-stage](https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/build-apps-for-teams-meeting-stage) and [Apps for Teams meetings](https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-apps-in-meetings):

- **Share** requires presenter or organizer role. Attendees get `doesAppHaveSharePermission = false` (the side panel disables the button).
- **In-tenant, guest, external (federated)** participants can see and interact with the app on stage. External users only in scheduled meetings (not 1:1/group calls).
- **Anonymous** participants (no Entra identity, joined via link) "can't see, share, or interact with the app that is being shared on the stage". For the pilot, every player needs a real account in some tenant. `meetingExtensionDefinition.supportsAnonymousGuestUsers` exists in the schema but its effect on stage apps is not documented; the canonical manifest sets it to `true` as an experiment (flip to `false` if the pilot admin objects) - treat the effect as unverified.
- Live Share: "supports guest and external users for most meeting types" (not guests in channel meetings). Max 100 attendees per session. [Live Share FAQ](https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-faq)
- Default meeting options make everyone a presenter unless the organizer changes it.

## 8. Camera inside the Teams iframe

`devicePermissions: ["media"]` is declared. Teams handles the device prompt itself; in the **web** client users must open the tab's dropdown > **App permissions**, enable camera, then reload - your page must tell them where that is. [Browser device permissions (2026-04-07)](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/device-capabilities/browser-device-permissions). `stage.html` has a **Camera probe** button that calls `getUserMedia` and prints the outcome so you know before wiring MediaPipe in.

## 9. Local run without Teams (no tenant needed)

```powershell
npx tinylicious@latest          # Fluid test server on http://localhost:7070 (PORT env var to change)
npx serve -l 3000 .             # any static server
# open twice:  http://localhost:3000/stage.html?inTeams=0
```

`TestLiveShareHost` hard-codes `http://localhost:7070`, stores the container id in the URL hash, and gives every client organizer+presenter+attendee roles. Copy the URL (with `#containerId`) into the second window to join the same container. Two laptops: forward 7070 with `devtunnel connect` on the second machine or edit the host endpoint. Sources: [Live Share local testing](https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-capabilities), [TestLiveShareHost.ts](https://github.com/microsoft/live-share-sdk/blob/main/packages/live-share/src/TestLiveShareHost.ts), [Tinylicious](https://fluidframework.com/docs/testing/tinylicious/).

## 10. What needs admin, at a glance

| Step | Needs tenant admin? |
| --- | --- |
| Create tenant (A/B) | You become the admin |
| Turn on *Upload custom apps* + org-wide custom app settings | Yes (Teams admin / Global admin) |
| Enable Public preview in web client | User-level, but only shown if the user may upload custom apps |
| Upload the zip, add to meeting | No, once the policy applies (up to 24 h) |
| External participants joining | Meeting organizer's tenant policy for external/anonymous access |
| Live Share hosted Fluid relay | No setup; free; data kept <= 24 h |
