# Consent and notice copy: the exact in-app strings

Drafts for engineering; counsel edits before the pilot. Each string has an id used by `privacy-risk.md` (R7-R15) and by the patches. Placeholders in `[brackets]` are filled per deployment. All strings are plain text; the twin renders them with Fluent tokens (`research/ui/teams-tokens.css`). Announcement rules follow `research/ui/accessibility.md:79-81` (one polite region for game events, one assertive region for errors and notices; never per frame).

## C1. First-run consent dialog (gates `getUserMedia`; R9, R10)

Sizes: in-meeting dialog 280..460 px wide, 300 px tall (`research/ui/layout-spec.md:67`); on the twin, a modal at the same size. `role="dialog" aria-modal="true" aria-labelledby="c1-title"`. Cannot be dismissed by clicking outside; Escape = "Not now".

**Title (c1-title):** Use your camera for hand tracking?

**Body:**

hopeOS tracks your hands (and, if you turn on Body, your body pose) on this device to draw the holohands and play the ball game. Your camera picture never leaves this device on the tracking path.

What is shared while you play:
- Hand landmark data (21 points per hand, including a metric hand-shape model) and, if Body is on, 33 body points, about 30 times a second.
- It goes only to the other people in this meeting so their screens can show your hands, through [Microsoft's Live Share relay (deleted within 24 hours) | the relay operated by [PILOT-PARTNER] | a relay operated by hopeOS that keeps nothing].
- Face data (mesh and expressions) is never sent anywhere.

Length of term: for this meeting only. hopeOS keeps none of it afterwards. Details, retention and your rights: [privacy.html link] - Data retention policy.

By pressing "I agree" you confirm that you have read this notice and you agree to the collection of your hand (and body) geometry data for the purpose above and for the length of term above, and to sharing it with the other participants of this meeting. You can stop at any time with "On-device only" or by turning the camera off.

**Buttons:** [I agree and turn on camera]   [Not now]

**Secondary link:** Use hopeOS without sharing (on-device only)

**Illinois notice line (shown to everyone; BIPA s.15(b)):** This notice and your agreement are recorded on this device (date, version [consentVersion]). It is not sent to hopeOS.

Rationale: s.15(b)(1)-(3) require written notice of collection, of the specific purpose and length of term, and a written release - all three are in the body and the button. The GDPR Art. 13 items (controller, purposes, recipients, retention, rights) are one link away in `privacy.html`, which the store rule also requires to be reachable without sign-in.

## C2. Consent version bump (R9)

**Toast / dialog title:** Our data notice changed

**Body:** Since you last agreed, hopeOS changed what it shares while you play: [one line, e.g. "body pose can now be shared when Body is on"]. Please read the updated notice and agree again to keep sharing.

**Buttons:** [Review and agree]   [Keep on-device only]

## C3. Tracking indicators in tile chrome (R8)

Rendered as a pill beside the name label (`layout-spec.md:118-121`), `aria-live` off; announced once via the polite region when state changes, throttled to one per 2 s.

- Local tile, tracking running: **Tracking on this device**  (`title`: "Your hands are tracked here. Landmarks are shared with this meeting.")
- Local tile, on-device only: **On-device only**  (`title`: "Nothing is sent to other participants.")
- Local tile, camera off: **Camera off**
- Remote tile, packets arriving: **Landmarks from [seat label]**  (`title`: "This person's hand data is drawn here. Their camera picture is not received.")
- Remote tile, no packets for 2 s: **No tracking data**
- Announcement strings: "Tracking started on this device", "Sharing paused - on-device only", "Tracking data from [name] resumed", "Tracking data from [name] lost".

## C4. On-device-only toggle in the control bar (R7)

Button label: **On-device only**  (toggle; `aria-pressed`)
`title` when off: "Stop sharing your hand data with this meeting. Tracking keeps working for you."
`title` when on: "Resume sharing your hand data with this meeting."
Announcement: "Sharing off. Nothing leaves this device." / "Sharing on."

## C5. ACS recording and transcription notices (R14; contractual per Learn "User privacy for Teams external users", retrieved 2026-09-18)

Banner row above the control bar, `aria-live="assertive"`, red/marigold per token, shown while the feature flag is true:

- Recording: **This meeting is being recorded by the organiser.** Everything you show in your tile, including your avatar, is part of the recording.
- Transcription: **This meeting is being transcribed.** Your voice in the call may be transcribed by the organiser's tenant.
- Both: **This meeting is being recorded and transcribed.**
- Consent gate (`isTeamsConsentRequired` true, before `grantTeamsConsent()`): dialog title **Recording consent needed** - body "The organiser records or transcribes this meeting and requires your consent. Until you agree, your camera and microphone stay off in the meeting." Buttons [I consent] [Leave meeting].
- Cleared: announcement "Recording stopped." / "Transcription stopped."

## C6. External participant label (R15)

Tile pill for the ACS-joined page (Teams itself shows "External"): **External via hopeOS**
`title`: "This participant joined through the hopeOS page using Azure Communication Services, not the Teams client."
Roster line when we join: display name passed to ACS is "[Name] (hopeOS)".

## C7. Voice and text command processing notice (R5, R6, R16)

Shown once, inline in the command bar (side panel Game tab / `Ctrl+/` popover, `layout-spec.md:173`), with a "Got it" dismissal stored in `localStorage`; repeated in the push-to-talk button `title`.

**Inline notice:** Commands are processed by AI services outside this meeting. Hold the button to record; the recording is sent to OpenAI for speech-to-text, and the text plus a list of the objects in the scene (no camera, no hand data, no names) is sent to Anthropic's Claude to carry out the command. Nothing is sent while the button is not held. OpenAI does not keep the recording after transcribing it; Anthropic [deletes command text within 30 days | keeps nothing at rest]. See [privacy.html] for details.

**Push-to-talk button:** label **Hold to talk**; while held **Listening... release to send**; after release **Sending to speech-to-text...**; then the HUD reply.
**Text field placeholder:** Type a command (sent to Claude)
**Error, service unreachable:** "Command service unreachable - using the on-device command grammar." (matches `mode: 'auto'` fallback, `research/command-agent/NOTES.md:92`)

## C8. Camera permission help (Teams web client)

From `research/meeting-app/README.md:118`: "in the web client users must open the tab's dropdown > App permissions, enable camera, then reload".

**Text:** Teams has not given this app camera access yet. In Teams on the web, open the tab's menu (...) > App permissions, turn on Camera, then reload this app. On the Teams desktop app, accept the camera prompt.

## C9. Live Share retention line (privacy.html and C1)

Data sent through Microsoft's Live Share service for this meeting "might be accessible for up to 24 hours, though in most cases it's deleted within six hours" (Microsoft Live Share FAQ). hopeOS sends only hand and body landmark data and game state through it - never your camera picture or face data.

## C10. "Not a Microsoft product" disclaimer for the sandbox (branding, `licences.md` section 4)

Persistent footer strip in the twin (never hidden by full-screen), 12 px, plus the About panel:

**Strip:** hopeOS Meeting Sandbox - a local test harness that imitates the Microsoft Teams meeting layout for engineering. Not a Microsoft product; not affiliated with or endorsed by Microsoft.

**About panel trademark footnote:** Microsoft, Azure, Fluent and Microsoft Teams are trademarks of the Microsoft group of companies. hopeOS is not affiliated with, endorsed by, or sponsored by Microsoft. Licences: [/licenses.html].

## C11. Body toggle (pose 33 is optional; R3)

Control-bar item **Body** (toggle, off by default). `title` off: "Also track and share your body pose (33 points) for the avatar body and body collisions." `title` on: "Stop sharing body pose."
When first turned on, a one-line confirm: "Share your body pose with this meeting as well? It is covered by the notice you agreed to." [Share body pose] [Cancel]

## C12. Face-ID enrolment (not in the pilot; kept for the memo's "Local face identification" feature, R18)

Only if ever built: **Enrol your face on this device?** - "hopeOS will store a small numeric face profile (not a picture) in this browser only, to keep your avatar attached to you when several people share one camera. Matching happens on this device and nothing is uploaded. You can remove the profile at any time under Settings > Face profile. Your organisation's admin can turn this feature off." [Enrol] [No thanks]. Requires explicit consent (GDPR Art. 9(2)(a)) and counsel sign-off.

## C13. Bug report (R21)

If a bug button exists in the twin: "Send a bug report (text and technical details only - no screenshot, no camera, no hand data)". The `screenshot` field is never populated.

## C14. Manifest descriptions (already compliant, for reference)

`research/video-effects/manifest.json:23` says "All inference runs on your device; frames are never uploaded." Keep it, and add to the meeting-app long description (`research/meeting-app/manifest.json:22`): "Hand landmark data is shared with meeting participants through Live Share; camera video and face data never leave your device. Privacy: [privacyUrl]."
