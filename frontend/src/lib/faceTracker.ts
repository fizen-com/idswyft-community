// Real-time head-pose tracking in the browser via MediaPipe Face Landmarker.
//
// Used to GUIDE the active-liveness head-turn challenge: it gives live yaw so the
// UI can advance only on real movement and capture the frame at the actual turn
// peak. The engine still scores the submitted frames server-side — this is
// guidance, not the security boundary.
//
// Yaw is derived from landmarks with the SAME geometry the engine's
// HeadTurnVerifier uses (nose tip vs. eye-corner midpoint), so what the user sees
// pass on-device matches what the server scores.

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

// WASM is loaded from the MediaPipe CDN for now; the model is self-hosted under
// /public/mediapipe. TODO(prod): self-host the wasm too before PYK production.
const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const MODEL_PATH = '/mediapipe/face_landmarker.task';

// MediaPipe FaceMesh (468-point) indices
const NOSE_TIP = 1;
const EYE_R_OUTER = 33;   // subject's right eye, outer corner
const EYE_L_OUTER = 263;  // subject's left eye, outer corner

let landmarkerPromise: Promise<FaceLandmarker> | null = null;

/** Load (once) and return the shared FaceLandmarker. Rejects if WASM/model fail. */
export function loadFaceLandmarker(): Promise<FaceLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
      return FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_PATH },
        runningMode: 'VIDEO',
        numFaces: 1,
      });
    })().catch((err) => {
      // Allow a later retry by clearing the cached rejected promise.
      landmarkerPromise = null;
      throw err;
    });
  }
  return landmarkerPromise;
}

export interface YawSample {
  /** Degrees. Positive = nose shifted toward image-right (physical LEFT turn on a
   *  front camera) — matches the engine's sign convention. 0 when no face. */
  yaw: number;
  faceFound: boolean;
}

/** Run one detection on the current video frame and estimate head yaw. */
export function detectYaw(
  landmarker: FaceLandmarker,
  video: HTMLVideoElement,
  timestampMs: number,
): YawSample {
  let result;
  try {
    result = landmarker.detectForVideo(video, timestampMs);
  } catch {
    return { yaw: 0, faceFound: false };
  }
  const faces = result?.faceLandmarks;
  if (!faces || faces.length === 0) return { yaw: 0, faceFound: false };

  const pts = faces[0];
  const nose = pts[NOSE_TIP];
  const eyeR = pts[EYE_R_OUTER];
  const eyeL = pts[EYE_L_OUTER];
  if (!nose || !eyeR || !eyeL) return { yaw: 0, faceFound: true };

  const eyeMidX = (eyeR.x + eyeL.x) / 2;
  const interEye = Math.abs(eyeL.x - eyeR.x);
  if (interEye < 1e-4) return { yaw: 0, faceFound: true };

  const offset = (nose.x - eyeMidX) / interEye;
  const yaw = Math.max(-90, Math.min(90, offset * 90));
  return { yaw, faceFound: true };
}
