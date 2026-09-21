// Microsoft Teams video-effect app skeleton: hopeOS holohands + a held object composited into YOUR outgoing video.
// Verified names (fetched 2026-09-18) come from:
//   - https://learn.microsoft.com/en-us/javascript/api/@microsoft/teams-js/videoeffects?view=msteams-client-js-latest  (BETA namespace)
//   - https://github.com/microsoft/teams-videoapp-sample  (test tool loads https://127.0.0.1:5173/)
//   - manifest: https://learn.microsoft.com/en-us/microsoft-365/extensibility/schema/root-meeting-extension-definition?view=m365-app-1.20
// Constraints (verbatim from the module docs): "We require the frame rate of the video to be at least 22fps for 720p";
// VideoFrameFormat "currently only support NV12"; "A host may support either VideoFrameHandler or VideoBufferHandler,
// but not both. To ensure the video effect works on all supported hosts, the video app must provide both";
// "When the failures accumulate to a certain number, the host will see the app is 'frozen'".
// Gating: "This namespace is in Beta ... Do not use this API in a production environment"; tenant admin toggle;
// explicit user consent to the video feed; and the manifest properties below exist only in the "m365-app-prev" moniker.
//
// manifest.json fragment (m365-app-prev schema; videoFilters max 32 items):
// "meetingExtensionDefinition": {
//   "videoFilters": [ { "id": "<GUID>", "name": "hopeOS holohands", "thumbnail": "thumb.png" } ],
//   "videoFiltersConfigurationUrl": "https://your.origin/effect.html"
// }

import { app, videoEffects } from '@microsoft/teams-js';

export async function main() {
  await app.initialize();
  if (!videoEffects.isSupported()) throw new Error('video capability not supported by this host');

  let activeEffectId;

  // "Register a callback to be notified when a new video effect is applied."
  // Pre-meeting: called immediately; in-meeting: "we will call videoEffectCallback when apply button clicked".
  videoEffects.registerForVideoEffect(async (effectId) => {
    activeEffectId = effectId;
    await hopeos.loadHands();            // MediaPipe HandLandmarker + holohand rig (ours)
    // resolve = prepared; throw videoEffects.EffectFailureReason.* on error
  });

  videoEffects.registerForVideoFrame({
    // Path 1: WebCodecs VideoFrame in, VideoFrame out ("At runtime it can be cast to VideoFrame directly").
    videoFrameHandler: async (videoFrameData) => {
      const inFrame = videoFrameData.videoFrame;              // W3C VideoFrame
      const outFrame = await hopeos.compose(inFrame);         // track hands, place object, return new VideoFrame
      inFrame.close();
      return outFrame;                                        // resolve = processed; reject = failure
    },
    // Path 2: raw NV12 buffer in place.
    videoBufferHandler: (bufferData, notifyVideoFrameProcessed, notifyError) => {
      try {
        hopeos.composeNV12InPlace(bufferData);                // VideoBufferData: NV12 planes + width/height
        notifyVideoFrameProcessed();
      } catch (e) { notifyError(e); }
    },
    // The module page's sample writes `videoEffects.VideoPixelFormat.NV12`, but the enum the page lists is
    // `VideoFrameFormat` ("currently only support NV12"). Use whichever your installed teams-js exports.
    config: { format: videoEffects.VideoFrameFormat.NV12 },
  });

  // Tell Teams when the user changes a parameter in our config page.
  document.getElementById('apple').onclick = () =>
    videoEffects.notifySelectedVideoEffectChanged(videoEffects.EffectChangeType.EffectChanged, activeEffectId);
}

// hopeos.compose sketch (ours, not Teams API):
//   1. draw VideoFrame to an OffscreenCanvas; 2. HandLandmarker.detectForVideo; 3. rebuild the 20-bone rig;
//   4. run prop physics (hull vs hull, wrap-to-pickup); 5. render three.js over the frame;
//   6. new VideoFrame(offscreenCanvas, { timestamp: inFrame.timestamp }).
// Budget: ~45 ms per frame at 22 fps; MediaPipe hands + three.js at 720p must fit, so run tracking in a Worker
// (the Zoom Video SDK's VideoProcessor runs its processFrame in a web worker for the same reason).
const hopeos = { loadHands: async () => {}, compose: async (f) => f, composeNV12InPlace: () => {} };
