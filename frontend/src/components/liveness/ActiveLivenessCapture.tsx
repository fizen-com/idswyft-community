import { useRef, useEffect, useState, useCallback } from 'react';
import { useActiveLiveness, type LivenessMetadata } from '../../hooks/useActiveLiveness';

interface ActiveLivenessCaptureProps {
  onComplete: (blob: Blob, metadata: LivenessMetadata) => void;
  onCancel: () => void;
  onFallback: () => void;
  /** When true, shows a processing overlay after liveness completes */
  isProcessing?: boolean;
}

// ─── Camera error mapping ──────────────────────────────────────
//
// Map a thrown getUserMedia / play() error to a user-facing message.
// Only NotFoundError (no camera hardware) is a legitimate fallback to
// the legacy static-photo capture — every other class shows a visible
// error and lets the user retry. Falling back on permission/setup
// errors silently strands iOS users on a path that can never pass
// liveness anti-spoofing (Community #37).

interface CameraErrorInfo {
  message: string;
  allowFallback: boolean;
}

function mapCameraError(err: unknown): CameraErrorInfo {
  if (err instanceof Error) {
    switch (err.name) {
      case 'NotAllowedError':
        return {
          message: 'Odmowa dostępu do kamery. Zezwól na dostęp do kamery w ustawieniach przeglądarki i spróbuj ponownie.',
          allowFallback: false,
        };
      case 'NotFoundError':
        return {
          message: 'Nie wykryto kamery w tym urządzeniu.',
          allowFallback: true,
        };
      case 'NotReadableError':
        return {
          message: 'Kamera jest używana przez inną aplikację. Zamknij inne aplikacje korzystające z kamery i spróbuj ponownie.',
          allowFallback: false,
        };
      case 'OverconstrainedError':
        return {
          message: 'Kamera nie spełnia wymagań (potrzebna jest przednia kamera).',
          allowFallback: false,
        };
      default:
        return {
          message: `Dostęp do kamery nie powiódł się (${err.name}): ${err.message}`,
          allowFallback: false,
        };
    }
  }
  return {
    message: 'Dostęp do kamery nie powiódł się z nieznanego powodu.',
    allowFallback: false,
  };
}

// Stream-readiness timeout — if the `playing` event hasn't fired
// within this window after acquiring the stream, surface an error
// rather than leaving the user staring at a frozen video forever.
const STREAM_READY_TIMEOUT_MS = 8000;

// Frame styling shared across pre-camera, error, and streaming UI.
const FRAME_STYLE: React.CSSProperties = {
  position: 'relative',
  width: '100%',
  maxWidth: 520,
  margin: '0 auto',
  background: 'var(--paper)',
  border: '1px solid var(--rule)',
  overflow: 'hidden',
  fontFamily: 'var(--sans)',
  color: 'var(--ink)',
};

export function ActiveLivenessCapture({
  onComplete,
  onCancel,
  onFallback,
  isProcessing = false,
}: ActiveLivenessCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const readyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [cameraRequested, setCameraRequested] = useState(false);
  const [streamReady, setStreamReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  // Always portrait — objectFit:'cover' crops landscape webcam feeds to fit.
  // Keeping portrait ensures the oval face guide frames faces correctly on all devices.
  const videoDims = { w: 480, h: 640 };

  // Cleanup any active stream on unmount or before retry.
  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (readyTimerRef.current) {
      clearTimeout(readyTimerRef.current);
      readyTimerRef.current = undefined;
    }
  }, []);

  useEffect(() => stopStream, [stopStream]);

  // Stop any in-flight speech when the component unmounts.
  useEffect(() => () => { try { window.speechSynthesis?.cancel(); } catch { /* noop */ } }, []);

  // Preload TTS voices (getVoices() is async on Android/Chrome — empty until the
  // 'voiceschanged' event fires; without this the first prompt can be silent).
  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const load = () => { try { synth.getVoices(); } catch { /* noop */ } };
    load();
    synth.addEventListener?.('voiceschanged', load);
    return () => synth.removeEventListener?.('voiceschanged', load);
  }, []);

  // Request camera access. CRITICAL: this must be invoked synchronously
  // from a user-gesture handler (button onClick) — iOS Safari rejects
  // getUserMedia calls that happen after any `await` in an async handler
  // because the gesture context expires across the microtask. Calling
  // it inside useEffect (the previous shape) was the iOS root cause.
  const requestCamera = useCallback(() => {
    stopStream();
    setCameraError(null);
    setCameraRequested(true);
    setStreamReady(false);

    // Prime speech synthesis within this user gesture so iOS Safari will allow
    // the later (programmatic) voice prompts during the challenge.
    try {
      const synth = window.speechSynthesis;
      if (synth) {
        const warm = new SpeechSynthesisUtterance(' ');
        warm.volume = 0; warm.lang = 'pl-PL';
        synth.speak(warm);
      }
    } catch { /* no speech support — silent */ }

    // Synchronous getUserMedia call — no awaited code can run before this line
    // when this function is invoked from a button onClick.
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'user' }, audio: false })
      .then((stream) => {
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) {
          // Component unmounted between the gesture and the resolved promise.
          stream.getTracks().forEach(t => t.stop());
          streamRef.current = null;
          return;
        }
        video.srcObject = stream;

        // Wait for the video to actually start rendering frames before
        // letting the liveness state machine begin its challenge.
        video.addEventListener(
          'playing',
          () => {
            if (readyTimerRef.current) {
              clearTimeout(readyTimerRef.current);
              readyTimerRef.current = undefined;
            }
            setStreamReady(true);
          },
          { once: true },
        );

        // Surface play() rejections instead of swallowing them — on iOS this
        // is one of the failure modes that previously left the user stranded.
        // Clear the readiness timer too so the 8s timeout doesn't later
        // overwrite this more specific message.
        video.play().catch(() => {
          if (readyTimerRef.current) {
            clearTimeout(readyTimerRef.current);
            readyTimerRef.current = undefined;
          }
          setCameraError('Nie udało się uruchomić podglądu z kamery. Spróbuj ponownie.');
        });

        // If `playing` doesn't fire within the timeout, surface an error
        // rather than leaving the user staring at a frozen black video.
        readyTimerRef.current = setTimeout(() => {
          setCameraError('Kamera nie uruchomiła się w ciągu 8 sekund. Spróbuj ponownie.');
        }, STREAM_READY_TIMEOUT_MS);
      })
      .catch((err: unknown) => {
        const { message, allowFallback } = mapCameraError(err);
        // Keep the original error in the console for support diagnostics.
        console.error('Camera access failed:', err);
        if (allowFallback) {
          // No camera hardware — the legacy static-photo capture is our only path.
          onFallback();
        } else {
          setCameraError(message);
        }
      });
  }, [onFallback, stopStream]);

  // ── Voice guidance (Web Speech API — works on iOS Safari + Android Chrome) ──
  const speak = useCallback((text: string) => {
    try {
      const synth = window.speechSynthesis;
      if (!synth) return;

      const utter = () => {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'pl-PL';
        u.rate = 1.0;
        u.pitch = 1.0;
        // Prefer a Polish voice if the device has one; else any voice (Android
        // can refuse to speak an utterance whose lang has no matching voice).
        const voices = synth.getVoices();
        const pl = voices.find(v => v.lang?.toLowerCase().startsWith('pl'));
        if (pl) u.voice = pl;
        synth.speak(u);
        // Android Chrome sometimes leaves the queue paused — nudge it.
        synth.resume();
      };

      // Cancelling immediately before speak() can drop the utterance on Android
      // Chrome. Cancel, then speak on the next tick to avoid the race.
      if (synth.speaking || synth.pending) {
        synth.cancel();
        setTimeout(utter, 60);
      } else {
        utter();
      }
    } catch { /* speech not supported — silent */ }
  }, []);

  const handleComplete = useCallback(
    (blob: Blob, metadata: LivenessMetadata) => {
      stopStream();
      onComplete(blob, metadata);
    },
    [onComplete, stopStream],
  );

  const {
    phase,
    direction,
    instruction,
    liveHint,
    progress,
    holdProgress,
    turnNumber,
    trackingReady,
    error,
    retry,
  } = useActiveLiveness({
    videoElement: streamReady ? videoRef.current : null,
    canvasElement: canvasRef.current,
    enabled: streamReady,
    onComplete: handleComplete,
    onFallback,
  });

  // Track the current direction in a ref so the phase-cue effect can read it
  // without depending on it (direction is updated mid-'return_center' to set up
  // the next turn — depending on it would re-fire the "wróć na środek" prompt).
  const directionRef = useRef(direction);
  useEffect(() => { directionRef.current = direction; }, [direction]);

  // ── Phase transition cues: voice (all platforms incl. iOS) + haptics (Android).
  //    Fires ONCE per phase change — deps are [phase] only, on purpose. ──
  useEffect(() => {
    // Haptics — Android only; iOS Safari has no Vibration API (silent no-op there).
    const vib = typeof navigator !== 'undefined' && navigator.vibrate
      ? navigator.vibrate.bind(navigator) : null;

    if (phase === 'turn') {
      vib?.(45);
      const dir = directionRef.current === 'left' ? 'w lewo' : 'w prawo';
      // Speak only the current action — no countdown (the visual ring shows time).
      speak(`Obróć głowę ${dir} i trzymaj.`);
    } else if (phase === 'return_center') {
      vib?.(45);
      speak('Wróć na środek.');
    } else if (phase === 'completed') {
      vib?.([30, 50, 30]);
      speak('Gotowe.');
    } else if (phase === 'failed') {
      vib?.(140);
      speak('Nie udało się. Spróbuj ponownie.');
    }
  }, [phase, speak]);

  // ── Pre-camera intro screen — gates getUserMedia behind an explicit user gesture ──
  if (!cameraRequested) {
    return (
      <div style={FRAME_STYLE}>
        <style>{LIVENESS_CSS}</style>
        <div className="lv-intro">
          <h2 className="lv-intro-title">Sprawdzenie żywotności</h2>

          {/* Demo: animated head turning left ↔ right */}
          <div className="lv-demo" aria-hidden="true">
            <svg className="lv-demo-head" width="96" height="96" viewBox="0 0 96 96" fill="none">
              <ellipse cx="48" cy="48" rx="30" ry="36" fill="none" stroke="var(--accent)" strokeWidth="2.5" />
              <circle className="lv-demo-eye" cx="38" cy="42" r="3.2" fill="var(--accent)" />
              <circle className="lv-demo-eye" cx="58" cy="42" r="3.2" fill="var(--accent)" />
              <path className="lv-demo-nose" d="M48 48 L44 58 L52 58 Z" fill="var(--accent)" opacity="0.7" />
            </svg>
            <div className="lv-demo-arrows">
              <span>◀</span><span>▶</span>
            </div>
          </div>

          <p className="lv-intro-body">
            Obróć powoli głowę w bok i wróć do środka, gdy pojawi się prośba.
            Użyjemy przedniej kamery, by potwierdzić, że to naprawdę Ty — obraz nie
            jest zapisywany jako nagranie.
          </p>
          <div className="lv-sound-note">
            🔊 Włącz dźwięk i wyłącz tryb cichy — będziemy mówić, co robić.
          </div>
          <button onClick={requestCamera} className="lv-btn-primary">
            Włącz kamerę
          </button>
          <button onClick={onCancel} className="lv-btn-ghost">
            Pomiń
          </button>
        </div>
      </div>
    );
  }

  // ── Camera error screen — surfaces NotAllowed / NotReadable / play() / timeout ──
  if (cameraError) {
    return (
      <div style={FRAME_STYLE}>
        <style>{LIVENESS_CSS}</style>
        <div className="lv-intro">
          <h2 className="lv-intro-title lv-intro-title--err">Błąd kamery</h2>
          <p className="lv-intro-body">{cameraError}</p>
          <button onClick={requestCamera} className="lv-btn-primary">
            Spróbuj ponownie
          </button>
          <button onClick={onCancel} className="lv-btn-ghost">
            Pomiń
          </button>
        </div>
      </div>
    );
  }

  // ── Dot state computation ──
  // 4 progress dots: turn 1 + return 1 + turn 2 + return 2
  const TOTAL_DOTS = 4;

  const getActiveStep = (): number => {
    if (phase === 'ready') return -1;
    if (phase === 'completed') return TOTAL_DOTS;
    if (phase === 'failed') return Math.min(Math.floor(progress * 4), TOTAL_DOTS - 1);
    // progress is 0/4..4/4 — map to dot index
    return Math.min(Math.floor(progress * 4), TOTAL_DOTS - 1);
  };

  const activeStep = getActiveStep();

  const getDotState = (i: number): 'done' | 'active' | 'pending' => {
    if (i < activeStep) return 'done';
    if (i === activeStep) return 'active';
    return 'pending';
  };

  // ── Border state ──
  const borderState = phase === 'failed' ? 'fail'
    : phase === 'completed' ? 'success'
    : (phase === 'turn' || phase === 'return_center') ? 'active'
    : 'idle';

  const showScanLine = phase !== 'completed' && phase !== 'failed';
  const challengeActive = phase === 'turn' || phase === 'return_center';

  // ── Tip text ──
  const tipText = phase === 'ready' ? 'Dobre światło · Odkryta twarz · Bez okularów przeciwsłonecznych'
    : phase === 'failed' ? 'Zadbaj o dobre światło i wyśrodkuj twarz'
    : phase === 'completed' ? 'Weryfikacja zakończona'
    : 'Trzymaj twarz widoczną przez cały czas';

  // ── Oval stroke color ──
  const ovalStroke = borderState === 'fail' ? '#ff3b5c'
    : borderState === 'success' ? '#00d4b4'
    : borderState === 'active' ? '#00ffdf'
    : '#00d4b4';

  return (
    <div style={FRAME_STYLE}>
      <style>{LIVENESS_CSS}</style>

      {/* Video + Overlays */}
      <div style={{
        position: 'relative',
        width: '100%',
        aspectRatio: `${videoDims.w}/${videoDims.h}`,
        maxHeight: '70vh',
      }}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            transform: 'scaleX(-1)',
          }}
        />
        <canvas ref={canvasRef} style={{ display: 'none' }} />

        {/* Ambient glow — top-left */}
        <div className="lv-glow lv-glow-tl" />

        {/* Oval face guide with mask + animated border */}
        <svg
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            zIndex: 2,
          }}
          viewBox={`0 0 ${videoDims.w} ${videoDims.h}`}
          preserveAspectRatio="xMidYMid slice"
        >
          <defs>
            <mask id="face-oval-mask">
              <rect width={videoDims.w} height={videoDims.h} fill="white" />
              <ellipse
                cx={videoDims.w / 2}
                cy={videoDims.h * 0.42}
                rx={videoDims.w * 0.27}
                ry={videoDims.h * 0.265}
                fill="black"
              />
            </mask>
          </defs>
          {/* Darken area outside the oval */}
          <rect
            width={videoDims.w}
            height={videoDims.h}
            fill="rgba(4,13,26,0.55)"
            mask="url(#face-oval-mask)"
          />
          {/* Animated oval border */}
          <ellipse
            cx={videoDims.w / 2}
            cy={videoDims.h * 0.42}
            rx={videoDims.w * 0.27}
            ry={videoDims.h * 0.265}
            fill="none"
            stroke={ovalStroke}
            strokeWidth={2.5}
            className={`lv-oval lv-oval--${borderState}`}
          />
        </svg>

        {/* Scan line */}
        {showScanLine && (
          <div className={`lv-scan ${challengeActive ? 'lv-scan--fast' : ''}`} />
        )}

        {/* Direction arrow for head turn — large, animated toward the turn side */}
        {phase === 'turn' && (
          <div style={{
            position: 'absolute',
            top: '42%',
            left: direction === 'right' ? 'auto' : 8,
            right: direction === 'right' ? 8 : 'auto',
            transform: 'translateY(-50%)',
            zIndex: 5,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
          }}>
            <div className={`lv-arrow lv-arrow--${direction}`}>
              <svg width="76" height="76" viewBox="0 0 24 24" fill="none">
                <path
                  d={direction === 'right'
                    ? 'M5 12h14m0 0l-6-6m6 6l-6 6'
                    : 'M19 12H5m0 0l6-6m-6 6l6 6'}
                  stroke="#00ffdf"
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <span className="lv-arrow-label">{direction === 'left' ? 'LEWO' : 'PRAWO'}</span>
          </div>
        )}

        {/* Processing overlay — shown while backend analyzes */}
        {isProcessing && (
          <div className="lv-processing">
            <div className="lv-processing-spinner" />
            <p className="lv-processing-text">Processing verification...</p>
            <p className="lv-processing-sub">Analyzing your document and identity</p>
          </div>
        )}

        {/* Cancel pill — top-left */}
        {!isProcessing && (
          <button onClick={onCancel} className="lv-cancel">
            {phase === 'completed' ? 'Gotowe' : 'Pomiń'}
          </button>
        )}

        {/* Glassmorphism instruction bar — bottom overlay */}
        {!isProcessing && (
          <div className="lv-bar">
            <p className="lv-bar-text" style={{
              color: phase === 'completed' ? '#00d4b4' : phase === 'failed' ? '#ff3b5c' : '#e8f4f8',
            }}>
              {instruction}
            </p>

            {error && <p className="lv-bar-error">{error}</p>}

            {/* Live coaching hint (realtime tracking only) */}
            {challengeActive && trackingReady && liveHint && (
              <p className="lv-hint">{liveHint}</p>
            )}

            {/* Hold progress bar — fills left→right while you hold the pose */}
            {challengeActive && (
              <div className="lv-holdbar">
                <div
                  className="lv-holdbar-fill"
                  style={{ width: `${Math.round(Math.max(0, Math.min(1, holdProgress)) * 100)}%` }}
                />
              </div>
            )}

            {/* Step label */}
            {challengeActive && (
              <span className="lv-step">Obrót {turnNumber} z 2</span>
            )}

            {/* Challenge progress dots */}
            <div className="lv-dots">
              {Array.from({ length: TOTAL_DOTS }).map((_, i) => (
                <div key={i} className={`lv-dot lv-dot--${getDotState(i)}`} />
              ))}
            </div>

            {/* Tip */}
            <div className="lv-tip">
              <span className="lv-tip-dot" />
              <span>{tipText}</span>
            </div>

            {/* Retry button */}
            {phase === 'failed' && (
              <button onClick={retry} className="lv-btn-retry">
                Spróbuj ponownie
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Injected CSS ──────────────────────────────────────

const LIVENESS_CSS = `
/* ── Pre-camera intro + camera-error screens ── */
.lv-intro {
  display: flex; flex-direction: column; align-items: center;
  text-align: center; gap: 14px;
  padding: 48px 28px;
}
.lv-intro-title {
  margin: 0;
  font-family: var(--sans);
  font-size: 20px; font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink);
}
.lv-intro-title--err { color: #ff3b5c; }
.lv-intro-body {
  margin: 0;
  max-width: 360px;
  font-family: var(--sans);
  font-size: 14px; line-height: 1.5;
  color: var(--mid);
}
.lv-sound-note {
  max-width: 340px;
  padding: 10px 14px;
  border: 1px solid var(--rule);
  background: var(--accent-soft, rgba(0,212,180,0.08));
  border-radius: 8px;
  font-family: var(--sans);
  font-size: 12.5px; line-height: 1.45;
  color: var(--ink);
}
.lv-btn-primary {
  margin-top: 10px;
  padding: 12px 32px;
  border: 1px solid var(--ink);
  background: var(--ink);
  color: var(--paper);
  font-family: var(--mono);
  font-size: 13px; font-weight: 500;
  letter-spacing: 0.05em; text-transform: uppercase;
  cursor: pointer;
  transition: transform 0.18s;
}
.lv-btn-primary:hover { transform: translateY(-1px); }
.lv-btn-ghost {
  padding: 8px 20px;
  border: 1px solid var(--rule);
  background: transparent;
  color: var(--mid);
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.07em;
  cursor: pointer;
  transition: all 0.18s;
}
.lv-btn-ghost:hover { border-color: var(--ink); color: var(--ink); }

/* ── Ambient Glow (removed for v2 -- kept as invisible placeholder) ── */
.lv-glow {
  position: absolute; pointer-events: none; z-index: 0; display: none;
}
.lv-glow-tl { display: none; }

/* ── Scan Line ── */
.lv-scan {
  position: absolute; left: 18%; right: 18%;
  height: 1px; z-index: 3; pointer-events: none;
  background: linear-gradient(90deg, transparent, var(--accent), transparent);
  animation: lv-fscan 2s ease-in-out infinite;
}
.lv-scan--fast { animation-duration: 0.9s; }

/* ── Oval Border Animations ── */
.lv-oval { transition: stroke 0.3s, filter 0.3s; }
.lv-oval--idle   { animation: lv-borderIdle 2.4s ease infinite; }
.lv-oval--active { animation: lv-borderActive 0.8s ease infinite; }
.lv-oval--success { animation: lv-borderSuccess 0.6s ease forwards; }
.lv-oval--fail   { filter: drop-shadow(0 0 30px rgba(255,59,92,0.35)); }

/* ── Direction Arrow (large, slides toward the turn side) ── */
.lv-arrow-pulse { animation: lv-arrowPulse 1.2s ease-in-out infinite; }
.lv-arrow {
  filter: drop-shadow(0 0 10px rgba(0,255,223,0.5));
}
.lv-arrow--left  { animation: lv-arrowSlideL 1s ease-in-out infinite; }
.lv-arrow--right { animation: lv-arrowSlideR 1s ease-in-out infinite; }
.lv-arrow-label {
  font-family: var(--mono);
  font-size: 13px; font-weight: 700; letter-spacing: 0.12em;
  color: #00ffdf;
  text-shadow: 0 0 8px rgba(0,255,223,0.5);
}

/* ── Hold countdown (centre of progress ring) ── */
.lv-countdown {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--sans);
  font-size: 24px; font-weight: 700;
  color: #eafffb;
  text-shadow: 0 0 8px rgba(0,212,180,0.6);
}

/* ── Live coaching hint ── */
.lv-hint {
  margin: 0;
  font-family: var(--sans);
  font-size: 13px; font-weight: 600;
  color: var(--accent);
  letter-spacing: 0.01em;
}

/* ── Hold progress bar ── */
.lv-holdbar {
  width: 100%; max-width: 280px; height: 8px;
  background: var(--rule);
  border-radius: 999px;
  overflow: hidden;
}
.lv-holdbar-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 999px;
  transition: width 0.09s linear;
}

/* ── Step label ── */
.lv-step {
  font-family: var(--mono);
  font-size: 11px; font-weight: 600; letter-spacing: 0.1em;
  color: var(--accent);
  text-transform: uppercase;
}

/* ── Intro demo (animated head turn) ── */
.lv-demo {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  margin: 6px 0 2px;
}
.lv-demo-head { animation: lv-demoTurn 2.8s ease-in-out infinite; transform-origin: 48px 48px; }
.lv-demo-arrows {
  display: flex; gap: 26px;
  font-size: 14px; color: var(--accent); opacity: 0.65;
  animation: lv-demoArrows 2.8s ease-in-out infinite;
}

/* ── Cancel Pill ── */
.lv-cancel {
  position: absolute; top: 12px; left: 12px; z-index: 10;
  padding: 6px 14px;
  border: 1px solid var(--rule);
  background: var(--panel);
  color: var(--mid);
  font-family: var(--mono);
  font-size: 11px; letter-spacing: 0.07em;
  cursor: pointer; transition: all 0.2s;
}
.lv-cancel:hover { border-color: var(--ink); color: var(--ink); }

/* ── Instruction Bar (solid panel) ── */
.lv-bar {
  position: absolute; bottom: 0; left: 0; right: 0; z-index: 6;
  padding: 14px 20px 18px;
  background: var(--panel);
  border-top: 1px solid var(--rule);
  display: flex; flex-direction: column; align-items: center; gap: 8px;
}
.lv-bar-text {
  margin: 0;
  font-family: var(--sans);
  font-size: 18px; font-weight: 700; letter-spacing: -0.01em;
  text-align: center; line-height: 1.25;
}
.lv-bar-error {
  margin: 0;
  font-family: var(--mono);
  font-size: 11px; color: #ff3b5c; letter-spacing: 0.04em;
}

/* ── Progress Dots ── */
.lv-dots { display: flex; gap: 6px; justify-content: center; }
.lv-dot {
  width: 6px; height: 6px;
  transition: all 0.3s cubic-bezier(.4,0,.2,1);
}
.lv-dot--done {
  background: var(--accent);
}
.lv-dot--active {
  background: var(--accent); width: 18px;
}
.lv-dot--pending { background: var(--rule); }

/* ── Tip Bar ── */
.lv-tip {
  display: flex; align-items: center; gap: 8px;
  font-family: var(--mono);
  font-size: 10px; color: var(--soft);
  letter-spacing: 0.06em;
}
.lv-tip-dot {
  width: 5px; height: 5px;
  background: var(--accent); flex-shrink: 0;
}

/* ── Retry Button ── */
.lv-btn-retry {
  margin-top: 2px; padding: 10px 28px; border: 1px solid var(--ink);
  background: var(--ink); color: var(--paper);
  font-family: var(--mono);
  font-size: 13px; font-weight: 500;
  letter-spacing: 0.05em; text-transform: uppercase;
  cursor: pointer; position: relative; overflow: hidden;
  transition: all 0.18s;
}
.lv-btn-retry:hover { transform: translateY(-1px); }

/* ── Processing Overlay ── */
.lv-processing {
  position: absolute; inset: 0; z-index: 20;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px;
  background: var(--panel);
  border: 1px solid var(--rule);
}
.lv-processing-spinner {
  width: 48px; height: 48px; border-radius: 50%;
  border: 3px solid var(--rule);
  border-top-color: var(--accent);
  animation: lv-spin 0.8s linear infinite;
}
.lv-processing-text {
  margin: 0;
  font-family: var(--sans);
  font-size: 16px; font-weight: 600; color: var(--ink);
  letter-spacing: -0.01em;
}
.lv-processing-sub {
  margin: 0;
  font-family: var(--mono);
  font-size: 11px; color: var(--soft);
  letter-spacing: 0.04em;
}

/* ── Keyframes ── */
@keyframes lv-fscan {
  0%   { top: 18%; opacity: 0; }
  8%   { opacity: 1; }
  92%  { opacity: 1; }
  100% { top: 66%; opacity: 0; }
}
@keyframes lv-borderIdle {
  0%, 100% { filter: drop-shadow(0 0 18px rgba(0,212,180,0.15)); }
  50%      { filter: drop-shadow(0 0 36px rgba(0,212,180,0.32)); }
}
@keyframes lv-borderActive {
  0%, 100% { filter: drop-shadow(0 0 24px rgba(0,255,223,0.3)); }
  50%      { filter: drop-shadow(0 0 50px rgba(0,255,223,0.55)); }
}
@keyframes lv-borderSuccess {
  from { filter: drop-shadow(0 0 20px rgba(0,212,180,0.3)); }
  to   { filter: drop-shadow(0 0 70px rgba(0,212,180,0.7)); }
}
@keyframes lv-arrowPulse {
  0%, 100% { opacity: 0.6; transform: scale(1); }
  50%      { opacity: 1; transform: scale(1.15); }
}
@keyframes lv-arrowSlideL {
  0%, 100% { opacity: 0.5; transform: translateX(6px); }
  50%      { opacity: 1; transform: translateX(-8px); }
}
@keyframes lv-arrowSlideR {
  0%, 100% { opacity: 0.5; transform: translateX(-6px); }
  50%      { opacity: 1; transform: translateX(8px); }
}
@keyframes lv-demoTurn {
  0%, 100% { transform: rotateY(0deg) translateX(0); }
  25%      { transform: rotateY(-32deg) translateX(-6px); }
  50%      { transform: rotateY(0deg) translateX(0); }
  75%      { transform: rotateY(32deg) translateX(6px); }
}
@keyframes lv-demoArrows {
  0%, 100% { opacity: 0.3; }
  25%, 75% { opacity: 0.85; }
  50%      { opacity: 0.3; }
}
@keyframes lv-spin {
  to { transform: rotate(360deg); }
}
`;
