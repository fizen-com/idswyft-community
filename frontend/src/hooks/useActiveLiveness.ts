import { useEffect, useRef, useState, useCallback } from 'react';
import { loadFaceLandmarker, detectYaw } from '../lib/faceTracker';
import type { FaceLandmarker } from '@mediapipe/tasks-vision';

// ─── Types ──────────────────────────────────────────────

export type LivenessPhase =
  | 'ready'
  | 'turn'
  | 'return_center'
  | 'capturing'
  | 'completed'
  | 'failed'
  | 'fallback';

export type ChallengeDirection = 'left' | 'right';

export interface AnalysisFrame {
  frame_base64: string;
  timestamp: number;
  phase: string;
  color_rgb?: [number, number, number];
}

export interface LivenessMetadata {
  challenge_type: 'head_turn';
  challenge_direction: ChallengeDirection;
  frames: AnalysisFrame[];
  color_sequence?: [number, number, number][];
  start_timestamp: number;
  end_timestamp: number;
  screen_width?: number;
  screen_height?: number;
  virtual_camera_check?: {
    label: string;
    suspected_virtual: boolean;
  };
}

export interface UseActiveLivenessOptions {
  videoElement: HTMLVideoElement | null;
  canvasElement: HTMLCanvasElement | null;
  enabled: boolean;
  onComplete: (bestFrame: Blob, metadata: LivenessMetadata) => void;
  onFallback: () => void;
  challengeTimeoutMs?: number;
}

export interface UseActiveLivenessReturn {
  phase: LivenessPhase;
  direction: ChallengeDirection;
  instruction: string;
  /** Live coaching hint, e.g. "Obróć bardziej" / "Trzymaj" (realtime mode only). */
  liveHint: string;
  progress: number;
  /** Smooth 0→1 fill progress through the current action (for the bottom bar). */
  holdProgress: number;
  /** Which scored turn we're on (1 or 2). */
  turnNumber: number;
  faceDetected: boolean;
  currentYaw: number;
  /** True once the on-device face tracker is ready (realtime guidance active). */
  trackingReady: boolean;
  error: string | null;
  retry: () => void;
}

// ─── Constants ──────────────────────────────────────────

const DEFAULT_CHALLENGE_TIMEOUT = 35000;
const TURN_HOLD_MS = 3000;         // timed-fallback: hold turn for 3s
const RETURN_HOLD_MS = 3000;       // timed-fallback: hold center for 3s

// Realtime (MediaPipe) thresholds — client targets a clear turn; the engine only
// needs ≥3° so capturing the peak here guarantees a server pass.
const TARGET_YAW = 12;             // degrees — client target for "turned enough"
const CENTER_YAW = 5;              // degrees — back-to-centre threshold
const STABLE_MS = 320;             // hold target/centre this long to confirm
const RT_TURN_TIMEOUT_MS = 22000;  // per-turn timeout in realtime mode
const MODEL_LOAD_TIMEOUT_MS = 9000; // fall back to timed mode if not ready by now

const VIRTUAL_CAMERA_REGEX = /obs|virtual|manycam|snap camera|fake|xsplit|streamlabs/i;

// ─── Helpers ────────────────────────────────────────────

function pickRandomDirection(): ChallengeDirection {
  return Math.random() < 0.5 ? 'left' : 'right';
}

function getInstructionForPhase(phase: LivenessPhase, direction: ChallengeDirection): string {
  switch (phase) {
    case 'ready': return 'Umieść twarz w owalu i nie ruszaj się';
    case 'turn': return direction === 'left' ? 'Obróć głowę w LEWO i przytrzymaj' : 'Obróć głowę w PRAWO i przytrzymaj';
    case 'return_center': return 'Wróć — patrz prosto w kamerę';
    case 'capturing': return 'Nie ruszaj się — zapisuję…';
    case 'completed': return 'Gotowe — twarz potwierdzona!';
    case 'failed': return 'Nie udało się. Dotknij, aby spróbować ponownie.';
    case 'fallback': return 'Kamera niedostępna. Używam standardowego trybu.';
    default: return '';
  }
}

/** Max analysis frame dimensions — keeps base64 under the 200K schema limit. */
const MAX_ANALYSIS_WIDTH = 640;
const MAX_ANALYSIS_HEIGHT = 480;

/** Capture a frame from video as base64 JPEG using the hidden canvas. */
function captureFrameAsBase64(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  quality: number = 0.7,
): string {
  const srcW = video.videoWidth || 640;
  const srcH = video.videoHeight || 480;
  const scale = Math.min(1, MAX_ANALYSIS_WIDTH / srcW, MAX_ANALYSIS_HEIGHT / srcH);
  canvas.width = Math.round(srcW * scale);
  canvas.height = Math.round(srcH * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality).replace(/^data:image\/jpeg;base64,/, '');
}

// ─── Hook ────────────────────────────────────────────────

export function useActiveLiveness(options: UseActiveLivenessOptions): UseActiveLivenessReturn {
  const {
    videoElement,
    canvasElement,
    enabled,
    onComplete,
    challengeTimeoutMs = DEFAULT_CHALLENGE_TIMEOUT,
  } = options;

  const [phase, setPhase] = useState<LivenessPhase>('ready');
  const [direction, setDirection] = useState<ChallengeDirection>(pickRandomDirection);
  const [progress, setProgress] = useState(0);
  const [holdProgress, setHoldProgress] = useState(0);
  const [turnNumber, setTurnNumber] = useState(1);
  const [currentYaw, setCurrentYaw] = useState(0);
  const [liveHint, setLiveHint] = useState('');
  const [trackingReady, setTrackingReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const phaseRef = useRef(phase);
  const directionRef = useRef(direction);
  const framesRef = useRef<AnalysisFrame[]>([]);
  const challengeStartRef = useRef(0);
  const returnStartRef = useRef(0);
  const virtualCameraRef = useRef<{ label: string; suspected_virtual: boolean } | undefined>(undefined);
  const turnDelayRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const turnCountRef = useRef(0);
  const scoredDirectionRef = useRef<ChallengeDirection>('left');

  // Realtime tracking refs
  const trackerRef = useRef<FaceLandmarker | null>(null);
  const trackingReadyRef = useRef(false);
  const rafRef = useRef(0);
  const stableSinceRef = useRef(0);
  const bestPeakRef = useRef<{ base64: string; absYaw: number } | null>(null);
  const phaseStartRef = useRef(0);

  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { directionRef.current = direction; }, [direction]);
  useEffect(() => { trackingReadyRef.current = trackingReady; }, [trackingReady]);

  // ── Load the on-device face tracker (best-effort; falls back to timed mode) ──
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const timeout = setTimeout(() => {
      // Don't block forever — timed mode will drive the challenge if the model
      // isn't ready. (trackingReady stays false.)
    }, MODEL_LOAD_TIMEOUT_MS);
    loadFaceLandmarker()
      .then((lm) => {
        if (cancelled) return;
        trackerRef.current = lm;
        setTrackingReady(true);
      })
      .catch(() => { /* timed fallback */ })
      .finally(() => clearTimeout(timeout));
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [enabled]);

  // ── Countdown ticker (timed mode only — realtime drives holdProgress live) ──
  useEffect(() => {
    if (trackingReady) return;
    if (phase !== 'turn' && phase !== 'return_center') { setHoldProgress(0); return; }
    const holdMs = phase === 'turn' ? TURN_HOLD_MS : RETURN_HOLD_MS;
    const start = performance.now();
    setHoldProgress(0);
    const id = setInterval(() => {
      const p = Math.min(1, (performance.now() - start) / holdMs);
      setHoldProgress(p);
      if (p >= 1) clearInterval(id);
    }, 50);
    return () => clearInterval(id);
  }, [phase, turnNumber, trackingReady]);

  // ── Virtual camera detection on mount ──
  useEffect(() => {
    if (!enabled || !videoElement) return;
    const stream = videoElement.srcObject as MediaStream | null;
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (track) {
      virtualCameraRef.current = {
        label: track.label,
        suspected_virtual: VIRTUAL_CAMERA_REGEX.test(track.label),
      };
    }
  }, [enabled, videoElement]);

  // ── Finalize: capture best frame and build metadata ──
  const finalizeLiveness = useCallback(() => {
    if (!canvasElement || !videoElement) {
      setPhase('failed');
      setError('Canvas not available for capture');
      return;
    }
    canvasElement.width = videoElement.videoWidth || 640;
    canvasElement.height = videoElement.videoHeight || 480;
    const ctx = canvasElement.getContext('2d');
    if (!ctx) {
      setPhase('failed');
      setError('Canvas context not available');
      return;
    }
    ctx.drawImage(videoElement, 0, 0);
    canvasElement.toBlob(
      (blob) => {
        if (!blob) {
          setPhase('failed');
          setError('Frame capture failed');
          return;
        }
        const metadata: LivenessMetadata = {
          challenge_type: 'head_turn',
          challenge_direction: scoredDirectionRef.current,
          frames: framesRef.current,
          start_timestamp: challengeStartRef.current,
          end_timestamp: performance.now(),
          screen_width: window.innerWidth,
          screen_height: window.innerHeight,
          virtual_camera_check: virtualCameraRef.current,
        };
        setProgress(1);
        setPhase('completed');
        onComplete(blob, metadata);
      },
      'image/jpeg',
      0.92,
    );
  }, [canvasElement, videoElement, onComplete]);

  // ── Shared transition: record the turn peak, then go to return_center ──
  const recordPeakAndReturn = useCallback((peakBase64?: string) => {
    if (!videoElement || !canvasElement) return;
    const isFirstTurn = turnCountRef.current === 0;
    framesRef.current.push({
      frame_base64: peakBase64 || captureFrameAsBase64(videoElement, canvasElement),
      timestamp: performance.now(),
      phase: isFirstTurn ? 'turn1_peak' : 'turn_peak',
    });
    setProgress(isFirstTurn ? 1 / 4 : 3 / 4);
    bestPeakRef.current = null;
    stableSinceRef.current = 0;
    returnStartRef.current = performance.now();
    phaseStartRef.current = performance.now();
    setHoldProgress(0);
    setLiveHint('');
    setPhase('return_center');
  }, [videoElement, canvasElement]);

  // ── Shared transition: record the return frame, then next turn or finalize ──
  const recordReturnAndAdvance = useCallback(() => {
    if (!videoElement || !canvasElement) return;
    const isFirstTurn = turnCountRef.current === 0;
    framesRef.current.push({
      frame_base64: captureFrameAsBase64(videoElement, canvasElement),
      timestamp: performance.now(),
      phase: isFirstTurn ? 'turn1_return' : 'turn_return',
    });
    stableSinceRef.current = 0;
    setHoldProgress(0);

    if (isFirstTurn) {
      setProgress(2 / 4);
      framesRef.current.push({
        frame_base64: captureFrameAsBase64(videoElement, canvasElement),
        timestamp: performance.now(),
        phase: 'turn_start',
      });
      turnCountRef.current = 1;
      setTurnNumber(2);
      setDirection(scoredDirectionRef.current);
      setLiveHint('');
      turnDelayRef.current = setTimeout(() => {
        if (phaseRef.current === 'return_center') {
          phaseStartRef.current = performance.now();
          setPhase('turn');
        }
      }, 1200);
    } else {
      setProgress(1);
      setPhase('capturing');
      finalizeLiveness();
    }
  }, [videoElement, canvasElement, finalizeLiveness]);

  // ── Auto-start challenge when video is playing ──
  useEffect(() => {
    if (phase !== 'ready' || !videoElement || !canvasElement || !enabled) return;

    const startChallenge = () => {
      framesRef.current = [];
      turnCountRef.current = 0;
      setTurnNumber(1);
      const firstDir = pickRandomDirection();
      scoredDirectionRef.current = firstDir === 'left' ? 'right' : 'left';
      setDirection(firstDir);
      challengeStartRef.current = performance.now();
      bestPeakRef.current = null;
      stableSinceRef.current = 0;
      framesRef.current.push({
        frame_base64: captureFrameAsBase64(videoElement, canvasElement),
        timestamp: performance.now(),
        phase: 'turn1_start',
      });
      phaseStartRef.current = performance.now();
      setPhase('turn');
    };

    if (videoElement.readyState >= 2) {
      const timer = setTimeout(startChallenge, 2500);
      return () => clearTimeout(timer);
    } else {
      const onPlaying = () => setTimeout(startChallenge, 2500);
      videoElement.addEventListener('playing', onPlaying);
      return () => videoElement.removeEventListener('playing', onPlaying);
    }
  }, [phase, videoElement, canvasElement, enabled]);

  // ── TIMED fallback: turn phase (only when tracking isn't ready) ──
  useEffect(() => {
    if (trackingReady) return;
    if (phase !== 'turn' || !videoElement || !canvasElement) return;
    let running = true;
    const timer = setTimeout(() => {
      if (running) recordPeakAndReturn();
    }, TURN_HOLD_MS);
    const timeoutTimer = setTimeout(() => {
      if (running && phaseRef.current === 'turn') {
        setPhase('failed');
        setError('Challenge timed out. Please try again.');
      }
    }, challengeTimeoutMs);
    return () => { running = false; clearTimeout(timer); clearTimeout(timeoutTimer); };
  }, [phase, videoElement, canvasElement, challengeTimeoutMs, trackingReady, recordPeakAndReturn]);

  // ── TIMED fallback: return-to-center phase ──
  useEffect(() => {
    if (trackingReady) return;
    if (phase !== 'return_center' || !videoElement || !canvasElement) return;
    let running = true;
    const timer = setTimeout(() => {
      if (running) recordReturnAndAdvance();
    }, RETURN_HOLD_MS);
    return () => { running = false; clearTimeout(timer); clearTimeout(turnDelayRef.current); };
  }, [phase, videoElement, canvasElement, trackingReady, recordReturnAndAdvance]);

  // ── REALTIME: yaw-driven loop (when the tracker is ready) ──
  useEffect(() => {
    if (!trackingReady || !trackerRef.current || !videoElement || !canvasElement) return;
    if (phase !== 'turn' && phase !== 'return_center') return;

    let running = true;
    const tracker = trackerRef.current;
    let lastTs = 0;

    const loop = () => {
      if (!running) return;
      const now = performance.now();
      // Throttle detection to ~25fps; MediaPipe needs increasing timestamps.
      if (now - lastTs >= 40 && videoElement.readyState >= 2) {
        lastTs = now;
        const { yaw, faceFound } = detectYaw(tracker, videoElement, now);
        if (faceFound) setCurrentYaw(yaw);
        const sign = directionRef.current === 'left' ? 1 : -1;

        if (phaseRef.current === 'turn') {
          const signed = yaw * sign;                 // progress toward target
          const p = Math.max(0, Math.min(1, signed / TARGET_YAW));
          setHoldProgress(p);
          // Track the best (max-yaw) frame so we capture the true peak.
          if (faceFound && signed > (bestPeakRef.current?.absYaw ?? 0)) {
            bestPeakRef.current = {
              base64: captureFrameAsBase64(videoElement, canvasElement),
              absYaw: signed,
            };
          }
          if (!faceFound) setLiveHint('Nie widzę twarzy — ustaw twarz w owalu');
          else if (signed < 0) setLiveHint(directionRef.current === 'left' ? 'Obróć w lewo' : 'Obróć w prawo');
          else if (signed < TARGET_YAW * 0.6) setLiveHint('Jeszcze trochę…');
          else if (signed < TARGET_YAW) setLiveHint('Prawie — odrobinę dalej');
          else setLiveHint('Trzymaj…');

          if (faceFound && signed >= TARGET_YAW) {
            if (!stableSinceRef.current) stableSinceRef.current = now;
            else if (now - stableSinceRef.current >= STABLE_MS) {
              recordPeakAndReturn(bestPeakRef.current?.base64);
            }
          } else {
            stableSinceRef.current = 0;
          }
        } else if (phaseRef.current === 'return_center') {
          const absY = Math.abs(yaw);
          const p = Math.max(0, Math.min(1, 1 - absY / TARGET_YAW));
          setHoldProgress(p);
          if (!faceFound) setLiveHint('Nie widzę twarzy');
          else if (absY > CENTER_YAW) setLiveHint('Wróć na środek');
          else setLiveHint('Trzymaj…');

          if (faceFound && absY <= CENTER_YAW) {
            if (!stableSinceRef.current) stableSinceRef.current = now;
            else if (now - stableSinceRef.current >= STABLE_MS) {
              recordReturnAndAdvance();
            }
          } else {
            stableSinceRef.current = 0;
          }
        }

        // Per-turn timeout
        if (phaseStartRef.current && now - phaseStartRef.current > RT_TURN_TIMEOUT_MS) {
          running = false;
          setPhase('failed');
          setError('Nie wykryto ruchu na czas. Spróbuj ponownie.');
          return;
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => { running = false; cancelAnimationFrame(rafRef.current); };
  }, [phase, trackingReady, videoElement, canvasElement, recordPeakAndReturn, recordReturnAndAdvance]);

  // ── Retry ──
  const retry = useCallback(() => {
    framesRef.current = [];
    turnCountRef.current = 0;
    challengeStartRef.current = 0;
    returnStartRef.current = 0;
    stableSinceRef.current = 0;
    bestPeakRef.current = null;
    setDirection(pickRandomDirection());
    setError(null);
    setProgress(0);
    setHoldProgress(0);
    setCurrentYaw(0);
    setLiveHint('');
    setTurnNumber(1);
    setPhase('ready');
  }, []);

  // ── Cleanup ──
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      if (turnDelayRef.current) clearTimeout(turnDelayRef.current);
    };
  }, []);

  return {
    phase,
    direction,
    instruction: getInstructionForPhase(phase, direction),
    liveHint,
    progress,
    holdProgress,
    turnNumber,
    faceDetected: true,
    currentYaw,
    trackingReady,
    error,
    retry,
  };
}
