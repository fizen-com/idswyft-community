import { useState } from 'react';
import { ActiveLivenessCapture } from '../components/liveness/ActiveLivenessCapture';
import type { LivenessMetadata } from '../hooks/useActiveLiveness';

// Standalone UX sandbox for the active-liveness challenge — NO document, NO API,
// NO handoff. Lets us iterate on the liveness UX directly at /liveness-test
// without running the whole verification flow each time. Not linked from the app.

// PYK theme vars (mirrors MobileVerificationPage so the component looks identical).
const THEME_VARS: React.CSSProperties = {
  // @ts-expect-error — CSS custom properties
  '--paper': '#F5F5F5',
  '--panel': '#FFFFFF',
  '--ink': '#1A1A2E',
  '--mid': '#5A5A6E',
  '--soft': '#9A9AA8',
  '--rule': '#E2E2E8',
  '--accent': '#1B8A4E',
  '--accent-soft': 'rgba(27,138,78,0.10)',
  '--accent-ink': '#0E5C33',
  '--flag': '#D14343',
  '--flag-soft': 'rgba(209,67,67,0.08)',
  '--sans': "'DM Sans', system-ui, sans-serif",
  '--mono': "'IBM Plex Mono', monospace",
};

export default function LivenessTestPage() {
  const [result, setResult] = useState<null | { ok: boolean; frames: number; dir: string }>(null);
  const [round, setRound] = useState(0); // bump key to remount/restart the component

  const handleComplete = (_blob: Blob, metadata: LivenessMetadata) => {
    setResult({ ok: true, frames: metadata.frames.length, dir: metadata.challenge_direction });
  };

  const restart = () => { setResult(null); setRound((r) => r + 1); };

  return (
    <div style={{
      ...THEME_VARS,
      minHeight: '100dvh',
      background: 'var(--paper)',
      color: 'var(--ink)',
      fontFamily: 'var(--sans)',
      padding: '20px 16px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 14,
    }}>
      <div style={{ width: '100%', maxWidth: 520 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: '4px 0 2px' }}>
          Test liveness (piaskownica)
        </h1>
        <p style={{ fontSize: 12.5, color: 'var(--mid)', margin: '0 0 12px' }}>
          Sama weryfikacja żywotności — bez dokumentu i bez wysyłki. Do dopracowania UX.
        </p>

        {!result ? (
          <ActiveLivenessCapture
            key={round}
            onComplete={handleComplete}
            onCancel={restart}
            onFallback={restart}
          />
        ) : (
          <div style={{
            background: 'var(--panel)', border: '1px solid var(--rule)',
            borderRadius: 12, padding: 20, textAlign: 'center',
          }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)' }}>
              ✓ Zaliczone (test)
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--mid)', marginTop: 6, fontFamily: 'var(--mono)' }}>
              klatki: {result.frames} · kierunek: {result.dir}
            </div>
            <button
              onClick={restart}
              style={{
                marginTop: 16, padding: '11px 22px', borderRadius: 10, border: 'none',
                background: 'var(--accent)', color: '#fff', fontFamily: 'var(--sans)',
                fontSize: 14, fontWeight: 600, cursor: 'pointer',
              }}
            >
              Jeszcze raz
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
