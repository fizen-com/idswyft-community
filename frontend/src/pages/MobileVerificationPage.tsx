import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { API_BASE_URL } from '../config/api';
import { sanitizeRedirectUrl, buildRedirectUrl } from '../utils/redirect';
import IDCameraCapture from '../components/IDCameraCapture';
import SelfieCameraCapture from '../components/SelfieCameraCapture';
import { ActiveLivenessCapture } from '../components/liveness/ActiveLivenessCapture';
import type { LivenessMetadata } from '../hooks/useActiveLiveness';

// ─── Design system CSS (v2 — technical editorial) ─────────────────────────
const css = `
@keyframes segPulse  { 0%,100%{opacity:0.4} 50%{opacity:1} }
@keyframes scan      { 0%{top:12px;opacity:0} 8%{opacity:1} 92%{opacity:1} 100%{top:calc(100% - 12px);opacity:0} }
@keyframes spin      { to{transform:rotate(360deg)} }
@keyframes blink     { 0%,100%{opacity:1} 50%{opacity:0.3} }
@keyframes fscan     { 0%{top:18%;opacity:0} 8%{opacity:1} 92%{opacity:1} 100%{top:88%;opacity:0} }
@keyframes dotsDrift { from{background-position:0 0} to{background-position:18px 18px} }
@keyframes fadeIn    { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
@keyframes slideIn   { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }

.mv-fade-up { animation: fadeIn 0.32s ease both; }
`;

// ─── Step definitions ───────────────────────────────────────────────────────
const FULL_STEP_LABELS = ['Przód', 'Tył', 'Weryfikacja', 'Twarz', 'Gotowe'];
const FULL_VOICE_STEP_LABELS = ['Przód', 'Tył', 'Weryfikacja', 'Twarz', 'Głos', 'Gotowe'];
const DOCUMENT_ONLY_STEP_LABELS = ['Przód', 'Tył', 'Weryfikacja', 'Gotowe'];
const IDENTITY_STEP_LABELS = ['Przód', 'Weryfikacja', 'Twarz', 'Gotowe'];
const AGE_ONLY_STEP_LABELS = ['Dowód', 'Gotowe'];
// Passport in document_only mode: front scan → done
const PASSPORT_DOC_ONLY_STEP_LABELS = ['Przód', 'Weryfikacja', 'Gotowe'];

// ─── Types ──────────────────────────────────────────────────────────────────
type Screen = 'front' | 'back' | 'checking' | 'live' | 'voice' | 'done';
const SCREENS: Screen[] = ['front', 'back', 'checking', 'live', 'voice', 'done'];
const SCREEN_IDX = { front: 0, back: 1, checking: 2, live: 3, voice: 4, done: 5 } as const;

// ─── Sub-Components ─────────────────────────────────────────────────────────

/* Step progress tracker — numbered circles + connectors (PYK style) */
const StepTracker: React.FC<{ activeIdx: number; labels?: string[] }> = ({ activeIdx, labels = FULL_STEP_LABELS }) => (
  <div style={{ padding: '16px 16px 4px', display: 'flex', alignItems: 'flex-start' }}>
    {labels.map((label, i) => {
      const state = i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'pending';
      const filled = state !== 'pending';
      return (
        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative', minWidth: 0 }}>
          {/* Connector line from the previous circle */}
          {i > 0 && (
            <div style={{
              position: 'absolute', top: 14, right: '50%', width: '100%', height: 2,
              background: i <= activeIdx ? 'var(--accent)' : 'var(--rule)',
            }} />
          )}
          {/* Circle */}
          <div style={{
            position: 'relative', zIndex: 1,
            width: 30, height: 30, borderRadius: '50%',
            background: filled ? 'var(--accent)' : 'var(--panel)',
            border: `2px solid ${filled ? 'var(--accent)' : 'var(--rule-strong)'}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: filled ? '#ffffff' : 'var(--mid)',
            fontFamily: 'var(--sans)', fontSize: 14, fontWeight: 700,
            boxShadow: state === 'active' ? '0 0 0 4px var(--accent-soft)' : 'none',
          }}>{state === 'done' ? '✓' : i + 1}</div>
          {/* Label */}
          <span style={{
            marginTop: 7, fontFamily: 'var(--sans)', fontSize: 11,
            fontWeight: state === 'active' ? 600 : 500, lineHeight: 1.2, textAlign: 'center',
            color: state === 'pending' ? 'var(--mid)' : 'var(--ink)', padding: '0 2px',
          }}>{label}</span>
        </div>
      );
    })}
  </div>
);

/* Tip bar — v2 prompt-tag style */
const TipBar: React.FC<{ text: string }> = ({ text }) => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 8,
    background: 'var(--accent-soft)', border: '1px solid var(--rule)',
    padding: '9px 13px',
    fontSize: 12, fontFamily: 'var(--mono)',
    color: 'var(--mid)', flexShrink: 0,
  }}>
    <div style={{ width: 5, height: 5, background: 'var(--accent)', flexShrink: 0 }} />
    {text}
  </div>
);

/* Primary button — v2 .btn style (square, mono font, solid accent) */
const PrimaryBtn: React.FC<{
  children: React.ReactNode; onClick: () => void; disabled?: boolean;
}> = ({ children, onClick, disabled }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    style={{
      width: '100%', padding: '15px 20px', border: 'none', borderRadius: 12,
      background: disabled ? 'var(--accent-soft)' : 'var(--accent)',
      color: disabled ? 'var(--mid)' : '#ffffff',
      fontFamily: 'var(--sans)', fontSize: 15, fontWeight: 600,
      letterSpacing: '0', textTransform: 'none',
      cursor: disabled ? 'not-allowed' : 'pointer',
      position: 'relative', overflow: 'hidden',
      transition: 'transform 120ms ease, opacity 120ms ease', flexShrink: 0,
      opacity: disabled ? 0.6 : 1,
    }}
  >
    {children}
  </button>
);

/* ID Card Viewfinder — v2 capture-frame (solid border, accent corner marks) */
const IDViewfinder: React.FC<{
  variant: 'front' | 'back'; processing: boolean; processingLabel: string;
  previewUrl?: string | null;
}> = ({ variant, processing, processingLabel, previewUrl }) => {
  // Corner marks: position + which two borders to show (sharp, no radius)
  const corners = [
    { top: 12, left: 12, bw: '2px 0 0 2px' },
    { top: 12, right: 12, bw: '2px 2px 0 0' },
    { bottom: 12, left: 12, bw: '0 0 2px 2px' },
    { bottom: 12, right: 12, bw: '0 2px 2px 0' },
  ];

  return (
    <div style={{
      width: '100%', aspectRatio: '1.586',
      border: '1px solid var(--ink)', background: 'var(--panel)',
      position: 'relative', overflow: 'hidden',
      flexShrink: 0, marginBottom: 18,
    }}>
      {/* Inner card mock or preview image */}
      {previewUrl ? (
        <img src={previewUrl} alt="Document preview" style={{
          position: 'absolute', inset: 16,
          objectFit: 'cover', width: 'calc(100% - 32px)', height: 'calc(100% - 32px)',
        }} />
      ) : (
        <div style={{
          position: 'absolute', inset: 16,
          background: 'var(--rule)', padding: '13px 15px',
          display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        }}>
          {variant === 'front' ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ width: 30, height: 22, background: 'var(--mid)', opacity: 0.35 }} />
                <div style={{ width: 38, height: 38, borderRadius: '50%', background: 'var(--rule-strong, var(--rule))', opacity: 0.3 }} />
              </div>
              <div>
                <div style={{ height: 5, background: 'var(--soft)', opacity: 0.25, width: '62%', marginBottom: 8 }} />
                <div style={{ height: 5, background: 'var(--soft)', opacity: 0.25, width: '42%' }} />
              </div>
              <div>
                <div style={{ height: 4, background: 'var(--accent)', opacity: 0.15, width: '90%', marginBottom: 4 }} />
                <div style={{ height: 4, background: 'var(--accent)', opacity: 0.15, width: '85%' }} />
              </div>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1, justifyContent: 'center' }}>
                {Array.from({ length: 16 }).map((_, i) => (
                  <div key={i} style={{
                    height: i % 4 === 0 ? 6 : i % 2 === 0 ? 4 : 3,
                    background: 'var(--accent)', opacity: 0.18,
                    width: `${48 + Math.abs(Math.sin(i * 1.3)) * 38}%`,
                  }} />
                ))}
              </div>
              <div style={{ marginTop: 8 }}>
                {[0, 1, 2].map(i => (
                  <div key={i} style={{ height: 4, background: 'var(--accent)', opacity: 0.15, width: `${90 - i * 5}%`, marginBottom: 4 }} />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Corner marks — accent color, sharp edges */}
      {corners.map((c, i) => (
        <div key={i} style={{
          position: 'absolute', width: 22, height: 22,
          borderStyle: 'solid', borderColor: 'var(--accent)',
          borderWidth: c.bw,
          ...(c.top !== undefined && { top: c.top }),
          ...(c.bottom !== undefined && { bottom: c.bottom }),
          ...(c.left !== undefined && { left: c.left }),
          ...(c.right !== undefined && { right: c.right }),
        } as React.CSSProperties} />
      ))}

      {/* Scan line */}
      {!processing && (
        <div style={{
          position: 'absolute', left: 12, right: 12, height: 1,
          background: 'var(--accent)',
          animation: 'scan 2s ease-in-out infinite',
        }} />
      )}

      {/* Processing overlay */}
      {processing && (
        <div style={{
          position: 'absolute', inset: 0, background: 'rgba(11,11,13,0.88)',
          backdropFilter: 'blur(3px)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12,
        }}>
          <div style={{
            width: 46, height: 46, border: '2px solid var(--rule)',
            borderTopColor: 'var(--accent)', borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }} />
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 11,
            color: 'var(--accent)', letterSpacing: '0.18em',
            animation: 'blink 1.4s ease infinite',
          }}>{processingLabel}</span>
        </div>
      )}
    </div>
  );
};

/* Ambient decoration — v2: subtle rule-colored lines instead of glow */
// Removed decorative divider line (was a thin horizontal rule at the top of each screen).
const AmbientGlow: React.FC = () => null;

/* Oval Face Viewfinder — v2: dashed oval with accent color */
const OvalFaceViewfinder: React.FC<{
  processing: boolean; previewUrl?: string | null;
}> = ({ processing, previewUrl }) => {
  const ovalRadius = '114px 114px 94px 94px';
  return (
    <div style={{
      width: 188, height: 228, borderRadius: ovalRadius,
      background: 'var(--panel)', position: 'relative', overflow: 'hidden',
      margin: '0 auto 22px', flexShrink: 0,
    }}>
      {/* Selfie preview when captured */}
      {previewUrl && (
        <img src={previewUrl} alt="Selfie preview" style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%',
          objectFit: 'cover', borderRadius: ovalRadius,
        }} />
      )}

      {/* Dot grid */}
      {!previewUrl && (
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: 'radial-gradient(circle, var(--soft) 1px, transparent 1px)',
          backgroundSize: '18px 18px', opacity: 0.3,
          animation: 'dotsDrift 4s linear infinite',
        }} />
      )}

      {/* Ghost silhouette */}
      {!previewUrl && (
        <div style={{
          position: 'absolute', bottom: -4, left: '50%', transform: 'translateX(-50%)',
          width: 90, height: 120, opacity: 0.06,
          background: 'linear-gradient(to bottom, transparent, var(--ink))',
          clipPath: 'polygon(35% 0%,65% 0%,80% 28%,82% 58%,92% 70%,100% 100%,0% 100%,8% 70%,18% 58%,20% 28%)',
        }} />
      )}

      {/* Horizontal scan line */}
      {!processing && !previewUrl && (
        <div style={{
          position: 'absolute', left: 0, right: 0, height: 1,
          background: 'var(--accent)',
          animation: 'fscan 1.9s ease-in-out infinite',
        }} />
      )}

      {/* Dashed oval border — accent color */}
      <div style={{
        position: 'absolute', inset: 0, borderRadius: ovalRadius,
        border: '2px dashed var(--accent)',
      }} />

      {/* Processing overlay */}
      {processing && (
        <div style={{
          position: 'absolute', inset: 0, background: 'rgba(11,11,13,0.88)',
          backdropFilter: 'blur(3px)', borderRadius: ovalRadius,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10,
        }}>
          <div style={{
            width: 46, height: 46, border: '2px solid var(--rule)',
            borderTopColor: 'var(--accent)', borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }} />
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 11,
            color: 'var(--accent)', letterSpacing: '0.18em',
            animation: 'blink 1.4s ease infinite',
          }}>CHECKING</span>
        </div>
      )}
    </div>
  );
};

/* Liveness Cues — 3 cycling circles */
const LIVENESS_CUES = [
  { emoji: '😐', label: 'Patrz przed siebie' },
  { emoji: '😊', label: 'Uśmiechnij się' },
  { emoji: '↔', label: 'Obróć lekko głowę' },
] as const;

const LivenessCues: React.FC<{ hidden?: boolean }> = ({ hidden }) => {
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    if (hidden) return;
    const iv = setInterval(() => setActiveIdx(i => (i + 1) % 3), 1600);
    return () => clearInterval(iv);
  }, [hidden]);

  if (hidden) return null;

  return (
    <div style={{ display: 'flex', gap: 22, justifyContent: 'center', margin: '18px 0' }}>
      {LIVENESS_CUES.map((cue, i) => {
        const isActive = i === activeIdx;
        return (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div style={{
              width: 40, height: 40,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 17,
              background: isActive ? 'var(--accent-soft)' : 'var(--panel)',
              border: `1px solid ${isActive ? 'var(--accent)' : 'var(--rule)'}`,
              transition: 'all 0.3s ease',
            }}>{cue.emoji}</div>
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 9,
              letterSpacing: '0.06em',
              color: isActive ? 'var(--accent-ink)' : 'var(--mid)',
              transition: 'color 0.3s ease',
            }}>{cue.label}</span>
          </div>
        );
      })}
    </div>
  );
};

// ─── Main Component ─────────────────────────────────────────────────────────
// Build a Polish, actionable hint explaining WHY a verification failed,
// so the user knows how to scan better next time.
const PB_FIELD_LABEL_PL: Record<string, string> = {
  full_name: 'imię i nazwisko',
  date_of_birth: 'data urodzenia',
  id_number: 'numer dokumentu',
  expiry_date: 'data ważności',
  nationality: 'obywatelstwo',
};
function getFailureHint(fr: any): string | null {
  if (!fr) return null;
  if (fr.rejection_reason === 'LIVENESS_FAILED' || fr.liveness_passed === false) {
    return 'Nie wykryto wyraźnego ruchu głową. Patrz prosto w kamerę i zdecydowanie obróć głowę w bok, potem wróć do środka — w dobrym świetle, bez nakrycia głowy.';
  }
  if (fr.face_match_passed === false) {
    return 'Twarz na selfie nie pasuje do zdjęcia z dowodu. Zrób selfie prosto w kamerę, w dobrym świetle, bez okularów i nakrycia głowy.';
  }
  if (fr.cross_validation_results?.document_expired) {
    return 'Dokument wygląda na przeterminowany — sprawdź datę ważności.';
  }
  const fs = fr.cross_validation_results?.field_scores || {};
  const bad = Object.keys(PB_FIELD_LABEL_PL).filter((k) => fs[k] && fs[k].passed === false);
  if (bad.length) {
    return `System nie odczytał pewnie: ${bad.map((k) => PB_FIELD_LABEL_PL[k]).join(', ')}. Zrób ostrzejsze zdjęcie — cała karta w kadrze, dobre światło, bez odblasków i rozmycia. Z tyłu upewnij się, że kod/MRZ jest wyraźny.`;
  }
  if (fr.rejection_reason === 'CROSS_VALIDATION_FAILED') {
    return 'Dane z przodu i tyłu nie zgodziły się lub zdjęcie było nieczytelne. Zrób ostrzejsze zdjęcie obu stron w dobrym świetle.';
  }
  return null;
}

// True when the document checks passed but the verification failed at the
// liveness / face-match stage — in that case we offer a retry of ONLY the live
// capture (the scanned document is preserved server-side).
function isLivenessStageFailure(fr: any): boolean {
  if (!fr) return false;
  return fr.rejection_reason === 'LIVENESS_FAILED'
    || fr.rejection_reason === 'FACE_NOT_DETECTED'
    || fr.rejection_reason === 'FACE_MATCH_FAILED'
    || fr.rejection_reason === 'DEEPFAKE_DETECTED'
    || fr.liveness_passed === false
    || fr.face_match_passed === false
    || fr.liveness_results?.liveness_passed === false
    || fr.face_match_results?.passed === false;
}

const MobileVerificationPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const verificationMode = searchParams.get('verification_mode') as 'full' | 'document_only' | 'identity' | 'age_only' | null;
  const ageThreshold = searchParams.get('age_threshold') ? parseInt(searchParams.get('age_threshold')!, 10) : undefined;
  const redirectUrl = sanitizeRedirectUrl(searchParams.get('redirect_url') || '');
  const isAgeOnly = verificationMode === 'age_only';
  const isDocumentOnly = verificationMode === 'document_only';
  const isIdentity = verificationMode === 'identity';

  // Handoff state
  const [_userId, setUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [patchFailed, setPatchFailed] = useState(false);

  // Verification flow state
  const [screenIdx, setScreenIdx] = useState(0);
  const [verificationId, setVerificationId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const documentType = 'national_id'; // tylko dowód osobisty — selektor typu usunięty

  // File state
  const [frontFile, setFrontFile] = useState<File | null>(null);
  const [frontPreviewUrl, setFrontPreviewUrl] = useState<string | null>(null);
  const [backFile, setBackFile] = useState<File | null>(null);
  const [backPreviewUrl, setBackPreviewUrl] = useState<string | null>(null);
  const [selfieFile, setSelfieFile] = useState<File | null>(null);
  const [selfiePreviewUrl, setSelfiePreviewUrl] = useState<string | null>(null);

  // Guided camera state
  const [showCamera, setShowCamera] = useState(false);
  const [cameraVariant, setCameraVariant] = useState<'front' | 'back'>('front');
  const [cameraSupported, setCameraSupported] = useState(true);
  const [showSelfieCamera, setShowSelfieCamera] = useState(false);

  // Active liveness state
  const [showActiveLiveness, setShowActiveLiveness] = useState(false);
  const [useFallbackSelfie, setUseFallbackSelfie] = useState(false);
  const selfieMetadataRef = useRef<LivenessMetadata | null>(null);

  // Checking screen messages
  const [checkingMsg, setCheckingMsg] = useState('Weryfikujemy Twój dokument…');

  // Passport back-skip state
  const [skipBack, setSkipBack] = useState(false);

  // Final result
  const [finalResult, setFinalResult] = useState<any>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [retryProcessing, setRetryProcessing] = useState(false);

  // Voice auth state
  const [voiceChallengeDigits, setVoiceChallengeDigits] = useState<string | null>(null);
  const [voiceExpiresIn, setVoiceExpiresIn] = useState<number | null>(null);
  const [voiceIsRecording, setVoiceIsRecording] = useState(false);
  const [voiceRecordingDuration, setVoiceRecordingDuration] = useState(0);
  const [voiceHasRecording, setVoiceHasRecording] = useState(false);
  const voiceMediaRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceAudioBlobRef = useRef<Blob | null>(null);
  const voiceTimerRef = useRef<number | null>(null);
  const voiceDurationRef = useRef<number | null>(null);
  const voiceExpiryRef = useRef<number | null>(null);

  // Page branding
  const [brandingLogo, setBrandingLogo] = useState<string | null>(null);
  const [brandingCompany, setBrandingCompany] = useState<string | null>(null);
  const [brandingAccent, setBrandingAccent] = useState<string | null>(null);
  // Page Builder config (theme, colors, font, step labels, completion copy) —
  // resolved from the developer record and delivered via the handoff session.
  const [pageConfig, setPageConfig] = useState<any>(null);

  const mountedRef = useRef(true);
  const redirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const screen: Screen = SCREENS[screenIdx];

  // ── Theme: PYK look by default (light, brand palette, DM Sans) ──────────
  // This fork serves PYK, so the verification flow defaults to PYK's design.
  // Page Builder config still overrides individual values on top.
  const PYK_BASE_VARS =
    "--paper:#F5F5F5;--panel:#FFFFFF;--ink:#1A1A2E;--mid:#5A5A6E;--soft:#9CA3AF;" +
    "--rule:#E6E7EB;--rule-strong:#D1D5DB;--panel-2:#FFFFFF;" +
    "--accent:#1B8A4E;--accent-ink:#137A42;--accent-soft:rgba(27,138,78,0.10);" +
    "--flag:#EF4444;--flag-soft:rgba(239,68,68,0.10);" +
    "--sans:'DM Sans',system-ui,-apple-system,sans-serif;--mono:'DM Sans',system-ui,sans-serif;";
  const pbTheme: 'light' | 'dark' = pageConfig?.theme === 'dark' ? 'dark' : 'light';
  useEffect(() => {
    const prev = document.documentElement.getAttribute('data-theme');
    document.documentElement.setAttribute('data-theme', pbTheme);
    return () => { if (prev) document.documentElement.setAttribute('data-theme', prev); };
  }, [pbTheme]);

  const PB_FONT_STACK: Record<string, string> = {
    'dm-sans': "'DM Sans', system-ui, sans-serif",
    'inter': "'Inter', system-ui, sans-serif",
    'geist': "'Geist', system-ui, sans-serif",
    'space-grotesk': "'Space Grotesk', system-ui, sans-serif",
    'manrope': "'Manrope', system-ui, sans-serif",
    'ibm-plex-mono': "'IBM Plex Mono', ui-monospace, monospace",
  };
  const isHex = (s: unknown): s is string => typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
  // PYK base palette always applied (scoped to active theme so it beats index.css),
  // then Page Builder config overrides appended after it.
  const pbThemeCss = (() => {
    const decls: string[] = [];
    if (isHex(pageConfig?.backgroundColor)) decls.push(`--paper: ${pageConfig.backgroundColor};`);
    if (isHex(pageConfig?.cardBackgroundColor)) decls.push(`--panel: ${pageConfig.cardBackgroundColor};`);
    if (isHex(pageConfig?.textColor)) decls.push(`--ink: ${pageConfig.textColor};`);
    const accent = isHex(pageConfig?.accentColor) ? pageConfig.accentColor : (isHex(brandingAccent) ? brandingAccent : null);
    if (accent) { decls.push(`--accent: ${accent};`); decls.push(`--accent-ink: ${accent};`); }
    const fam = pageConfig?.fontFamily && PB_FONT_STACK[pageConfig.fontFamily];
    if (fam) decls.push(`--sans: ${fam};`);
    return `html[data-theme="${pbTheme}"] { ${PYK_BASE_VARS}${decls.join(' ')} }`;
  })();

  // Map the default English stepper labels to the developer's configured labels.
  const localizeStepLabels = (labels: string[]): string[] => {
    const s = pageConfig?.steps;
    if (!s) return labels;
    const map: Record<string, unknown> = {
      'Front ID': s.front?.label,
      'Back ID': s.back?.label,
      'Live Photo': s.liveness?.label,
    };
    return labels.map((l) => (typeof map[l] === 'string' && map[l] ? (map[l] as string) : l));
  };

  // ── Cleanup + camera support check ──────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    setCameraSupported(!!navigator.mediaDevices?.getUserMedia);
    return () => {
      mountedRef.current = false;
      if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current);
      if (frontPreviewUrl) URL.revokeObjectURL(frontPreviewUrl);
      if (backPreviewUrl) URL.revokeObjectURL(backPreviewUrl);
      if (selfiePreviewUrl) URL.revokeObjectURL(selfiePreviewUrl);
    };
  }, []);

  // ── Handoff session fetch ──────────────────────────────────────────────
  useEffect(() => {
    if (!token) {
      setError('Nieprawidłowy link — brak tokenu.');
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    fetch(`${API_BASE_URL}/api/verify/handoff/${token}/session`, { signal: controller.signal })
      .then(r => {
        if (r.status === 410) throw new Error('Ten link wygasł. Poproś o nowy.');
        if (r.status === 409) throw new Error('Ten link został już użyty.');
        if (!r.ok) throw new Error('Nieprawidłowy lub nierozpoznany link.');
        return r.json();
      })
      .then(data => {
        if (!data.user_id) throw new Error('Odpowiedź sesji jest niekompletna. Spróbuj ponownie.');
        setUserId(data.user_id);
        // Apply branding from the session response (inlined by backend)
        if (data.branding) {
          setBrandingLogo(data.branding.logo_url);
          setBrandingCompany(data.branding.company_name);
          setBrandingAccent(data.branding.accent_color);
        }
        if (data.page_builder_config) setPageConfig(data.page_builder_config);
        // If the handoff session carries an existing verification_id (session-token
        // flow), reuse it instead of creating a duplicate via initialize.
        if (data.verification_id) {
          // Reuse existing verification — already linked in the handoff row
          setVerificationId(data.verification_id);
          setLoading(false);
        } else {
          // Legacy path: no pre-existing verification — create one
          initializeVerification(data.user_id, data.source);
        }
      })
      .catch(e => {
        if (e.name === 'AbortError') return;
        const isNetwork = e.message === 'Failed to fetch' || e.message === 'Load failed' || e.message.toLowerCase().includes('network');
        setError(
          isNetwork
            ? 'Nie można połączyć się z serwerem weryfikacji. Sprawdź połączenie z internetem i spróbuj ponownie.'
            : e.message
        );
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token]);

  // ── API helper ─────────────────────────────────────────────────────────
  const apiGet = useCallback(async (path: string) => {
    const res = await fetch(`${API_BASE_URL}${path}`, { headers: { 'X-Handoff-Token': token! } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }, [token]);

  // ── Step 0: Initialize verification session ────────────────────────────
  const initializeVerification = async (uid: string, source?: string) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/v2/verify/initialize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Handoff-Token': token! },
        body: JSON.stringify({
          user_id: uid,
          ...(source && { source }),
          ...(verificationMode && { verification_mode: verificationMode }),
          ...(ageThreshold && { age_threshold: ageThreshold }),
        }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.message || 'Failed to start'); }
      const data = await res.json();
      if (!mountedRef.current) return;
      setVerificationId(data.verification_id);
      // Link verification_id to handoff session (fire-and-forget)
      if (token) {
        fetch(`${API_BASE_URL}/api/verify/handoff/${token}/link`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ verification_id: data.verification_id }),
        }).catch(() => {});
      }
      setLoading(false);
    } catch (err: any) {
      if (mountedRef.current) {
        setError(err.message || 'Nie udało się rozpocząć weryfikacji');
        setLoading(false);
      }
    }
  };

  // ── Step: Upload front document ────────────────────────────────────────
  const handleFrontSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (frontPreviewUrl) URL.revokeObjectURL(frontPreviewUrl);
    setFrontFile(file);
    setFrontPreviewUrl(URL.createObjectURL(file));
    setStepError(null);
  };

  // ── Guided camera callbacks ─────────────────────────────────────────────
  const openCamera = useCallback((variant: 'front' | 'back') => {
    setCameraVariant(variant);
    setShowCamera(true);
  }, []);

  const handleCameraCapture = useCallback((file: File) => {
    setShowCamera(false);
    if (cameraVariant === 'front') {
      if (frontPreviewUrl) URL.revokeObjectURL(frontPreviewUrl);
      setFrontFile(file);
      setFrontPreviewUrl(URL.createObjectURL(file));
    } else {
      if (backPreviewUrl) URL.revokeObjectURL(backPreviewUrl);
      setBackFile(file);
      setBackPreviewUrl(URL.createObjectURL(file));
    }
    setStepError(null);
  }, [cameraVariant, frontPreviewUrl, backPreviewUrl]);

  const handleCameraClose = useCallback(() => {
    setShowCamera(false);
  }, []);

  const handleCameraFallback = useCallback(() => {
    setShowCamera(false);
    setCameraSupported(false);
    // Auto-click the hidden file input as fallback
    const inputId = cameraVariant === 'front' ? 'mv-front-upload' : 'mv-back-upload';
    setTimeout(() => document.getElementById(inputId)?.click(), 100);
  }, [cameraVariant]);

  // ── Guided selfie camera callbacks ────────────────────────────────────────
  const handleSelfieCameraCapture = useCallback((file: File) => {
    setShowSelfieCamera(false);
    if (selfiePreviewUrl) URL.revokeObjectURL(selfiePreviewUrl);
    setSelfieFile(file);
    setSelfiePreviewUrl(URL.createObjectURL(file));
    setStepError(null);
  }, [selfiePreviewUrl]);

  const handleSelfieCameraClose = useCallback(() => {
    setShowSelfieCamera(false);
  }, []);

  const handleSelfieCameraFallback = useCallback(() => {
    setShowSelfieCamera(false);
    setCameraSupported(false);
    setTimeout(() => document.getElementById('mv-selfie-upload')?.click(), 100);
  }, []);

  const uploadFront = async () => {
    if (!frontFile || !verificationId || !token) return;
    setIsProcessing(true);
    setStepError(null);
    try {
      const fd = new FormData();
      fd.append('document_type', documentType);
      fd.append('document', frontFile);
      const res = await fetch(`${API_BASE_URL}/api/v2/verify/${verificationId}/front-document`, {
        method: 'POST', headers: { 'X-Handoff-Token': token }, body: fd,
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.message || 'Upload failed'); }
      if (!mountedRef.current) return;
      const data = await res.json().catch(() => null);

      // Gate 1 may hard-reject (e.g. image too blurry for OCR) — let user retake
      if (data?.rejection_reason) {
        setStepError(data.message || 'The photo of your ID is not clear enough. Please retake it in good lighting.');
        setFrontFile(null);
        if (frontPreviewUrl) URL.revokeObjectURL(frontPreviewUrl);
        setFrontPreviewUrl(null);
        return;
      }

      // Age-only mode: front-document response includes final result directly
      if (isAgeOnly && data?.age_verification) {
        showFinalResult(data);
        return;
      }

      // Identity mode or passport: skip back doc — go to checking, then live capture
      const backSkipped = isIdentity || data?.detected_document_type === 'passport' || data?.requires_back === false;
      if (backSkipped) {
        setSkipBack(true);
        setScreenIdx(SCREEN_IDX.checking);
        pollFrontOCRForIdentity(0);
        return;
      }

      // Normal flow: move to back ID and poll OCR in background
      setScreenIdx(SCREEN_IDX.back);
      pollFrontOCR(0);
    } catch (err: any) {
      if (mountedRef.current) setStepError(err.message);
    } finally {
      if (mountedRef.current) setIsProcessing(false);
    }
  };

  // ── Poll front OCR ─────────────────────────────────────────────────────
  const pollFrontOCR = async (attempt: number) => {
    if (!verificationId || !token || !mountedRef.current) return;
    if (attempt >= 60) { setStepError('Przekroczono czas odczytu. Spróbuj ponownie.'); return; }
    try {
      const data = await apiGet(`/api/v2/verify/${verificationId}/status`);
      if (!mountedRef.current) return;
      if (data.ocr_data && Object.keys(data.ocr_data).length > 0) {
        // OCR complete — user can now upload back
        return;
      }
      if (data.final_result === 'failed' || data.final_result === 'manual_review') { showFinalResult(data); return; }
      setTimeout(() => pollFrontOCR(attempt + 1), 2000);
    } catch {
      if (mountedRef.current) setTimeout(() => pollFrontOCR(attempt + 1), 2000);
    }
  };

  // ── Poll front OCR for back-skip modes (identity/passport — skip back doc) ──
  const pollFrontOCRForIdentity = async (attempt: number) => {
    if (!verificationId || !token || !mountedRef.current) return;
    if (attempt >= 60) { setStepError('Przekroczono czas odczytu. Spróbuj ponownie.'); return; }
    try {
      const data = await apiGet(`/api/v2/verify/${verificationId}/status`);
      if (!mountedRef.current) return;
      // Check final_result first — document_only + passport completes after front
      if (data.final_result !== null && data.final_result !== undefined) {
        showFinalResult(data);
      } else if (data.ocr_data && Object.keys(data.ocr_data).length > 0) {
        setScreenIdx(SCREEN_IDX.live); // OCR done — proceed to live capture
      } else {
        setTimeout(() => pollFrontOCRForIdentity(attempt + 1), 2000);
      }
    } catch {
      if (mountedRef.current) setTimeout(() => pollFrontOCRForIdentity(attempt + 1), 2000);
    }
  };

  // ── Step: Upload back document ─────────────────────────────────────────
  const handleBackSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (backPreviewUrl) URL.revokeObjectURL(backPreviewUrl);
    setBackFile(file);
    setBackPreviewUrl(URL.createObjectURL(file));
    setStepError(null);
  };

  const uploadBack = async () => {
    if (!backFile || !verificationId || !token) return;
    setIsProcessing(true);
    setStepError(null);
    try {
      const fd = new FormData();
      fd.append('document', backFile);
      fd.append('document_type', documentType);
      const res = await fetch(`${API_BASE_URL}/api/v2/verify/${verificationId}/back-document`, {
        method: 'POST', headers: { 'X-Handoff-Token': token }, body: fd,
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.message || 'Upload failed'); }
      if (!mountedRef.current) return;

      // For document_only, the back-doc response may already include final_result
      // (cross-validation auto-triggers and completes synchronously).
      if (isDocumentOnly) {
        const data = await res.json().catch(() => null);
        if (data?.final_result) {
          showFinalResult(data);
          return;
        }
      }

      setScreenIdx(SCREEN_IDX.checking); // Checking screen
      pollCrossValidation(0);
    } catch (err: any) {
      if (mountedRef.current) setStepError(err.message);
    } finally {
      if (mountedRef.current) setIsProcessing(false);
    }
  };

  // ── Auto-scan: upload immediately once a photo is captured/selected ──────
  // (no separate "Skanuj przód/tył" confirm tap)
  useEffect(() => {
    if (frontFile && screen === 'front' && !isProcessing && verificationId) uploadFront();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frontFile]);
  useEffect(() => {
    if (backFile && screen === 'back' && !isProcessing && verificationId) uploadBack();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backFile]);

  // ── Poll cross-validation ──────────────────────────────────────────────
  const pollCrossValidation = async (attempt: number) => {
    if (!verificationId || !token || !mountedRef.current) return;
    if (attempt >= 60) { setStepError('Przekroczono czas weryfikacji. Spróbuj ponownie.'); return; }

    // Cycle checking messages
    if (attempt === 0) setCheckingMsg('Weryfikujemy Twój dokument…');

    try {
      const data = await apiGet(`/api/v2/verify/${verificationId}/status`);
      if (!mountedRef.current) return;
      const isComplete = !!data.cross_validation_results || data.final_result !== null;
      if (isComplete) {
        if (data.final_result === 'failed') { showFinalResult(data); }
        else if (isDocumentOnly) {
          // document_only: cross-validation is final gate, skip live capture.
          // If final_result is set, use it directly. Otherwise, infer from
          // cross-validation results (defensive: covers stale backend builds).
          if (data.final_result !== null) {
            showFinalResult(data);
          } else if (data.cross_validation_results) {
            const hasCriticalFailure = data.cross_validation_results.has_critical_failure;
            const verdict = data.cross_validation_results.verdict;
            showFinalResult({
              ...data,
              final_result: hasCriticalFailure ? 'failed'
                : verdict === 'REVIEW' ? 'manual_review'
                : verdict === 'REJECT' ? 'failed'
                : 'verified',
            });
          } else {
            // Shouldn't reach here — backend should return cross_validation_results
            // or final_result. Poll briefly in case of timing.
            setScreenIdx(SCREEN_IDX.done);
            waitForFinalResult(0);
          }
        }
        else { setScreenIdx(SCREEN_IDX.live); } // Live photo
      } else {
        setTimeout(() => pollCrossValidation(attempt + 1), 2000);
      }
    } catch {
      if (mountedRef.current) setTimeout(() => pollCrossValidation(attempt + 1), 2000);
    }
  };

  // Cycling messages for checking screen
  useEffect(() => {
    if (screen !== 'checking') return;
    const msgs = ['Weryfikujemy Twój dokument…', 'Sprawdzamy zgodność danych…', 'Już prawie gotowe…'];
    let idx = 0;
    const iv = setInterval(() => {
      idx = (idx + 1) % msgs.length;
      setCheckingMsg(msgs[idx]);
    }, 1800);
    return () => clearInterval(iv);
  }, [screen]);

  // ── Selfie capture (file input with capture="user") ────────────────────
  const handleSelfieSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (selfiePreviewUrl) URL.revokeObjectURL(selfiePreviewUrl);
    setSelfieFile(file);
    setSelfiePreviewUrl(URL.createObjectURL(file));
    setStepError(null);
  };

  // ── Active liveness complete — submit blob + metadata directly ─────────
  const handleActiveLivenessComplete = useCallback(async (blob: Blob, metadata: LivenessMetadata) => {
    if (!verificationId || !token) return;
    setIsProcessing(true);
    setStepError(null);
    try {
      const fd = new FormData();
      fd.append('selfie', blob, 'selfie.jpg');
      fd.append('liveness_metadata', JSON.stringify(metadata));
      const res = await fetch(`${API_BASE_URL}/api/v2/verify/${verificationId}/live-capture`, {
        method: 'POST', headers: { 'X-Handoff-Token': token }, body: fd,
      });
      if (!res.ok) { const e = await res.json().catch(() => ({ message: 'Liveness check failed' })); throw new Error(e.message || 'Liveness check failed'); }
      if (!mountedRef.current) return;

      // The live-capture response includes final_result — use it directly if available
      // to avoid depending on the polling loop (which can fail if session state save is delayed).
      const data = await res.json().catch(() => null);
      if (data?.status === 'AWAITING_VOICE') {
        setScreenIdx(SCREEN_IDX.voice);
      } else if (data?.final_result) {
        showFinalResult(data);
      } else {
        setScreenIdx(SCREEN_IDX.done);
        waitForFinalResult(0);
      }
    } catch (err: any) {
      if (mountedRef.current) {
        setShowActiveLiveness(false);
        setStepError(err.message);
      }
    } finally {
      if (mountedRef.current) setIsProcessing(false);
    }
  }, [verificationId, token]);

  const handleActiveLivenessFallback = useCallback(() => {
    setShowActiveLiveness(false);
    setUseFallbackSelfie(true);
  }, []);

  const uploadSelfie = async () => {
    if (!selfieFile || !verificationId || !token) return;
    setIsProcessing(true);
    setStepError(null);
    try {
      const fd = new FormData();
      fd.append('selfie', selfieFile);
      if (selfieMetadataRef.current) {
        fd.append('liveness_metadata', JSON.stringify(selfieMetadataRef.current));
      }
      const res = await fetch(`${API_BASE_URL}/api/v2/verify/${verificationId}/live-capture`, {
        method: 'POST', headers: { 'X-Handoff-Token': token }, body: fd,
      });
      if (!res.ok) { const e = await res.json().catch(() => ({ message: 'Selfie upload failed' })); throw new Error(e.message || 'Selfie upload failed'); }
      if (!mountedRef.current) return;

      // Use the response's final_result directly if available (avoids polling dependency)
      const data = await res.json().catch(() => null);
      if (data?.final_result) {
        showFinalResult(data);
      } else {
        setScreenIdx(SCREEN_IDX.done); // Done screen
        waitForFinalResult(0);
      }
    } catch (err: any) {
      if (mountedRef.current) setStepError(err.message);
    } finally {
      if (mountedRef.current) setIsProcessing(false);
    }
  };

  const waitForFinalResult = async (attempt: number) => {
    if (!verificationId || !token || !mountedRef.current) return;
    if (attempt >= 60) {
      if (mountedRef.current) setStepError('Weryfikacja trwa zbyt długo. Zamknij i spróbuj ponownie.');
      return;
    }
    try {
      const data = await apiGet(`/api/v2/verify/${verificationId}/status`);
      if (!mountedRef.current) return;
      if (data.status === 'AWAITING_VOICE') { setScreenIdx(SCREEN_IDX.voice); return; }
      if (data.final_result !== null) { showFinalResult(data); return; }

      // Defensive: infer final_result for identity mode from face match results
      // (covers stale backend builds where FLOW_PRESETS['identity'] may be missing)
      if (isIdentity && data.face_match_results) {
        const skipped = !!data.face_match_results.skipped_reason;
        showFinalResult({
          ...data,
          final_result: skipped ? 'manual_review' : 'verified',
        });
        return;
      }

      setTimeout(() => waitForFinalResult(attempt + 1), 3000);
    } catch {
      if (mountedRef.current) setTimeout(() => waitForFinalResult(attempt + 1), 3000);
    }
  };

  // ── Voice capture handlers ─────────────────────────────────────────────
  const resetVoiceState = () => {
    const recorder = voiceMediaRecorderRef.current;
    if (recorder?.state === 'recording') {
      recorder.stream.getTracks().forEach(t => t.stop());
      recorder.stop();
    }
    voiceMediaRecorderRef.current = null;
    if (voiceTimerRef.current) clearTimeout(voiceTimerRef.current);
    if (voiceDurationRef.current) clearInterval(voiceDurationRef.current);
    setVoiceChallengeDigits(null);
    setVoiceExpiresIn(null);
    setVoiceHasRecording(false);
    setVoiceIsRecording(false);
    setVoiceRecordingDuration(0);
    setStepError(null);
    voiceAudioBlobRef.current = null;
    voiceChunksRef.current = [];
    if (voiceExpiryRef.current) clearInterval(voiceExpiryRef.current);
  };

  const handleVoiceChallenge = async () => {
    if (!verificationId || !token) return;
    setIsProcessing(true);
    setStepError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/v2/verify/${verificationId}/voice-challenge`, {
        method: 'POST', headers: { 'X-Handoff-Token': token },
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Failed to get challenge'); }
      const data = await res.json();
      setVoiceChallengeDigits(data.challenge_digits);
      setVoiceExpiresIn(data.expires_in_seconds);
      if (voiceExpiryRef.current) clearInterval(voiceExpiryRef.current);
      const start = Date.now();
      const expSec = data.expires_in_seconds;
      voiceExpiryRef.current = window.setInterval(() => {
        const remaining = expSec - Math.floor((Date.now() - start) / 1000);
        if (remaining <= 0) { setVoiceExpiresIn(0); if (voiceExpiryRef.current) clearInterval(voiceExpiryRef.current); }
        else setVoiceExpiresIn(remaining);
      }, 1000) as unknown as number;
    } catch (err: any) {
      if (mountedRef.current) setStepError(err.message);
    } finally {
      if (mountedRef.current) setIsProcessing(false);
    }
  };

  const handleVoiceStartRecording = async () => {
    setStepError(null);
    voiceChunksRef.current = [];
    voiceAudioBlobRef.current = null;
    setVoiceHasRecording(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm',
      });
      recorder.ondataavailable = (e) => { if (e.data.size > 0) voiceChunksRef.current.push(e.data); };
      recorder.onstop = () => {
        voiceAudioBlobRef.current = new Blob(voiceChunksRef.current, { type: recorder.mimeType });
        setVoiceIsRecording(false);
        setVoiceHasRecording(true);
        if (voiceDurationRef.current) clearInterval(voiceDurationRef.current);
        stream.getTracks().forEach(t => t.stop());
      };
      voiceMediaRecorderRef.current = recorder;
      recorder.start(100);
      setVoiceIsRecording(true);
      setVoiceRecordingDuration(0);
      const dStart = Date.now();
      voiceDurationRef.current = window.setInterval(() => {
        setVoiceRecordingDuration(Math.floor((Date.now() - dStart) / 1000));
      }, 200) as unknown as number;
      voiceTimerRef.current = window.setTimeout(() => {
        if (voiceMediaRecorderRef.current?.state === 'recording') voiceMediaRecorderRef.current.stop();
      }, 10000) as unknown as number;
    } catch (err: any) {
      if (mountedRef.current) setStepError(err.message || 'Microphone access denied');
    }
  };

  const handleVoiceStopRecording = () => {
    if (voiceTimerRef.current) clearTimeout(voiceTimerRef.current);
    if (voiceMediaRecorderRef.current?.state === 'recording') voiceMediaRecorderRef.current.stop();
  };

  const handleVoiceSubmit = async () => {
    if (!verificationId || !token || !voiceAudioBlobRef.current) return;
    setIsProcessing(true);
    setStepError(null);
    try {
      const fd = new FormData();
      fd.append('file', voiceAudioBlobRef.current, 'voice.webm');
      const res = await fetch(`${API_BASE_URL}/api/v2/verify/${verificationId}/voice-capture`, {
        method: 'POST', headers: { 'X-Handoff-Token': token }, body: fd,
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Voice verification failed'); }
      if (voiceExpiryRef.current) clearInterval(voiceExpiryRef.current);
      // Go to done screen and poll for final result
      setScreenIdx(SCREEN_IDX.done);
      waitForFinalResult(0);
    } catch (err: any) {
      if (mountedRef.current) setStepError(err.message);
    } finally {
      if (mountedRef.current) setIsProcessing(false);
    }
  };

  // ── Retry failed verification ───────────────────────────────────────────
  const handleRetry = async () => {
    if (!verificationId || !token) return;
    if (redirectTimerRef.current) { clearTimeout(redirectTimerRef.current); redirectTimerRef.current = null; }
    setRetryProcessing(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/v2/verify/${verificationId}/restart`, {
        method: 'POST',
        headers: { 'X-Handoff-Token': token },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: 'Failed to restart' }));
        throw new Error(err.message || 'Failed to restart verification');
      }
      if (!mountedRef.current) return;
      // Reset all local state — reuse same verificationId
      if (frontPreviewUrl) URL.revokeObjectURL(frontPreviewUrl);
      if (backPreviewUrl) URL.revokeObjectURL(backPreviewUrl);
      if (selfiePreviewUrl) URL.revokeObjectURL(selfiePreviewUrl);
      setFrontFile(null);
      setFrontPreviewUrl(null);
      setBackFile(null);
      setBackPreviewUrl(null);
      setSelfieFile(null);
      setSelfiePreviewUrl(null);
      setFinalResult(null);
      setStepError(null);
      setShowActiveLiveness(false);
      setUseFallbackSelfie(false);
      setSkipBack(false);
      selfieMetadataRef.current = null;
      setScreenIdx(SCREEN_IDX.front); // Back to front ID
    } catch (err: any) {
      if (mountedRef.current) setStepError(err.message);
    } finally {
      if (mountedRef.current) setRetryProcessing(false);
    }
  };

  // ── Retry ONLY the live capture (document scan preserved) ─────────────────
  const handleRetryLiveness = async () => {
    if (!verificationId || !token) return;
    if (redirectTimerRef.current) { clearTimeout(redirectTimerRef.current); redirectTimerRef.current = null; }
    setRetryProcessing(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/v2/verify/${verificationId}/restart-liveness`, {
        method: 'POST',
        headers: { 'X-Handoff-Token': token },
      });
      if (!res.ok) {
        // Backend decided the document stage must be redone — fall back to full restart.
        if (res.status === 400) { await handleRetry(); return; }
        const err = await res.json().catch(() => ({ message: 'Failed to restart' }));
        throw new Error(err.message || 'Failed to restart liveness');
      }
      if (!mountedRef.current) return;
      // Reset ONLY the live-capture state — keep the scanned document files.
      if (selfiePreviewUrl) URL.revokeObjectURL(selfiePreviewUrl);
      setSelfieFile(null);
      setSelfiePreviewUrl(null);
      setFinalResult(null);
      setStepError(null);
      setShowActiveLiveness(false);
      setUseFallbackSelfie(false);
      selfieMetadataRef.current = null;
      setScreenIdx(SCREEN_IDX.live); // Jump straight to live capture
    } catch (err: any) {
      if (mountedRef.current) setStepError(err.message);
    } finally {
      if (mountedRef.current) setRetryProcessing(false);
    }
  };

  // ── Retry helper with exponential backoff ────────────────────────────────
  const patchWithRetry = async (url: string, body: object, maxRetries = 3): Promise<boolean> => {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const res = await fetch(url, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          keepalive: true,
        });
        if (res.ok || res.status === 409) return true;  // 409 = already completed
        if (res.status === 410) return false;            // expired — no point retrying
      } catch { /* network error — retry */ }
      if (i < maxRetries - 1) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
    }
    return false;
  };

  // ── Show final result & notify desktop ─────────────────────────────────
  const showFinalResult = async (data: any) => {
    if (!mountedRef.current) return;
    setFinalResult(data);
    setScreenIdx(SCREEN_IDX.done);
    const status = data.final_result ?? data.status;

    // On failure/review, pull the full status so we can tell the user WHICH
    // fields were unreadable (field-level hint on the result screen).
    if ((status === 'failed' || status === 'manual_review') && verificationId && token && !data.cross_validation_results) {
      fetch(`${API_BASE_URL}/api/v2/verify/${verificationId}/status`, { headers: { 'X-Handoff-Token': token } })
        .then(r => (r.ok ? r.json() : null))
        .then(s => { if (s && mountedRef.current) setFinalResult({ ...s, ...data }); })
        .catch(() => { /* keep original data */ });
    }

    // Start redirect timer immediately (don't block on handoff PATCH retries)
    if (redirectUrl) {
      redirectTimerRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        window.location.href = buildRedirectUrl(redirectUrl, {
          verification_id: data.verification_id,
          status,
          user_id: data.user_id,
        });
      }, 3000);
    }

    // Notify desktop via handoff complete (fire-and-forget relative to redirect)
    if (token) {
      const ok = await patchWithRetry(
        `${API_BASE_URL}/api/verify/handoff/${token}/complete`,
        {
          status: status === 'failed' ? 'failed' : 'completed',
          result: {
            verification_id: data.verification_id,
            status,
            user_id: data.user_id,
            confidence_score: data.confidence_score,
            face_match_score: data.face_match_results?.similarity_score ?? data.face_match_score,
            liveness_score: data.liveness_results?.liveness_score ?? data.liveness_score,
          },
        },
      );
      if (!ok && mountedRef.current) setPatchFailed(true);
    }
  };

  // ─── Shared styles — v2 tokens ──────────────────────────────────────
  const shellStyle: React.CSSProperties = {
    minHeight: '100dvh', width: '100%',
    background: 'var(--paper)',
    fontFamily: 'var(--sans)',
    color: 'var(--ink)',
    position: 'relative',
    overflow: 'hidden',
    display: 'flex', flexDirection: 'column',
  };

  const screenStyle: React.CSSProperties = {
    flex: 1, display: 'flex', flexDirection: 'column',
    padding: '0 24px 32px', overflow: 'hidden',
    position: 'relative',
  };

  // ─── Loading state ────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={shellStyle}>
        <style>{css}{pbThemeCss}</style>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
          <div style={{
            width: 56, height: 56, border: '2px solid var(--rule)',
            borderTopColor: 'var(--accent)', borderRadius: '50%',
            animation: 'spin 1s linear infinite',
          }} />
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 12,
            color: 'var(--mid)', letterSpacing: '0.08em',
          }}>Przygotowujemy Twoją sesję…</span>
        </div>
      </div>
    );
  }

  // ─── Error state ──────────────────────────────────────────────────────
  if (error) {
    return (
      <div style={shellStyle}>
        <style>{css}{pbThemeCss}</style>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 32px', gap: 16, textAlign: 'center' }}>
          <div style={{
            width: 72, height: 72,
            border: '1px solid var(--flag)',
            background: 'var(--flag-soft)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 32, color: 'var(--flag)',
          }}>!</div>
          <h2 style={{ fontFamily: 'var(--sans)', fontSize: 22, fontWeight: 700, letterSpacing: '-0.025em', lineHeight: 1.12 }}>
            Nie można wczytać
          </h2>
          <p style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--mid)', lineHeight: 1.55 }}>
            {error}
          </p>
        </div>
      </div>
    );
  }

  // ─── Verification flow ────────────────────────────────────────────────
  return (
    <div style={shellStyle}>
      <style>{css}{pbThemeCss}</style>

      {/* Branding logo header */}
      {brandingLogo && (
        <div style={{ textAlign: 'center', padding: '12px 24px 0' }}>
          <img src={brandingLogo} alt={brandingCompany || 'Logo'} style={{ height: 24, objectFit: 'contain' }} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
        </div>
      )}

      <div style={{ height: 8 }} />

      {/* Step progress */}
      <StepTracker
        activeIdx={
          isAgeOnly ? (screenIdx >= 4 ? 1 : 0)
          : (isIdentity || skipBack)
            ? (isDocumentOnly
              ? (screenIdx === 0 ? 0 : screenIdx === 2 ? 1 : 2)  // passport doc_only: Front→Checking→Complete
              : (screenIdx === 0 ? 0 : screenIdx === 2 ? 1 : screenIdx === 3 ? 2 : 3))  // passport full: Front→Checking→Live→Complete
          : isDocumentOnly ? (screenIdx >= 4 ? 3 : screenIdx)
          : screenIdx
        }
        labels={localizeStepLabels(
          isAgeOnly ? AGE_ONLY_STEP_LABELS
          : (isIdentity || skipBack)
            ? (isDocumentOnly ? PASSPORT_DOC_ONLY_STEP_LABELS : IDENTITY_STEP_LABELS)
          : isDocumentOnly ? DOCUMENT_ONLY_STEP_LABELS
          : screen === 'voice' || (screen === 'done' && screenIdx === SCREEN_IDX.done && voiceHasRecording) ? FULL_VOICE_STEP_LABELS
          : FULL_STEP_LABELS
        )}
      />

      {/* Screen content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', marginTop: 20 }}>

        {/* ── Screen 0: Front ID ──────────────────────────────────────── */}
        {screen === 'front' && (
          <div key="front" className="mv-fade-up" style={screenStyle}>
            <AmbientGlow />

            <h1 style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.15, letterSpacing: '-0.01em', marginBottom: 8 }}>
              {isAgeOnly ? <>Prześlij dowód,<br />aby potwierdzić wiek</> : <>Zeskanuj przód<br />dowodu osobistego</>}
            </h1>

            <p style={{ fontSize: 13, fontWeight: 400, color: 'var(--mid)', lineHeight: 1.55, marginBottom: 16 }}>
              {isAgeOnly
                ? `Sprawdzimy Twoją datę urodzenia, aby potwierdzić, że masz ukończone ${ageThreshold ?? 18} lat. Żadne inne dane nie są zapisywane.`
                : 'Ustaw dowód i zrób wyraźne zdjęcie. Upewnij się, że widać wszystkie cztery rogi, a tekst jest czytelny.'}
            </p>

            {/* Tylko dowód osobisty — selektor typu dokumentu usunięty (documentType jest na stałe 'national_id') */}

            <TipBar text="Dobre światło · Bez odblasków · Trzymaj nieruchomo" />

            <div style={{ marginTop: 12 }} />
            <IDViewfinder variant="front" processing={isProcessing} processingLabel="ODCZYT PRZODU" previewUrl={frontPreviewUrl} />

            {/* Hidden file input (fallback when camera unsupported) */}
            <input type="file" accept="image/*" capture="environment" id="mv-front-upload" style={{ display: 'none' }}
              onChange={handleFrontSelect} />

            {!frontFile ? (
              <PrimaryBtn
                onClick={() => cameraSupported ? openCamera('front') : document.getElementById('mv-front-upload')?.click()}
                disabled={isProcessing}
              >
                Zrób zdjęcie przodu
              </PrimaryBtn>
            ) : (
              <PrimaryBtn onClick={uploadFront} disabled={isProcessing}>
                {isProcessing ? 'Przetwarzanie…' : 'Skanuj przód dowodu'}
              </PrimaryBtn>
            )}

            {stepError && (
              <p style={{ marginTop: 10, fontSize: 12, color: 'var(--flag)', fontFamily: 'var(--mono)', textAlign: 'center' }}>
                {stepError}
              </p>
            )}
          </div>
        )}

        {/* ── Screen 1: Back ID ───────────────────────────────────────── */}
        {screen === 'back' && (
          <div key="back" className="mv-fade-up" style={screenStyle}>
            <AmbientGlow />

            <h1 style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.15, letterSpacing: '-0.01em', marginBottom: 8 }}>
              Teraz odwróć dowód<br />i zeskanuj tył
            </h1>

            <p style={{ fontSize: 13, color: 'var(--mid)', lineHeight: 1.55, marginBottom: 16 }}>
              Zachowaj te same warunki — dobre światło, płaska powierzchnia. Kod na tyle musi być w pełni widoczny.
            </p>

            <TipBar text="Kod kreskowy musi być w pełni widoczny" />

            <div style={{ marginTop: 12 }} />
            <IDViewfinder variant="back" processing={isProcessing} processingLabel="ODCZYT KODU" previewUrl={backPreviewUrl} />

            {/* Hidden file input (fallback when camera unsupported) */}
            <input type="file" accept="image/*" capture="environment" id="mv-back-upload" style={{ display: 'none' }}
              onChange={handleBackSelect} />

            {!backFile ? (
              <PrimaryBtn
                onClick={() => cameraSupported ? openCamera('back') : document.getElementById('mv-back-upload')?.click()}
                disabled={isProcessing}
              >
                Zrób zdjęcie tyłu
              </PrimaryBtn>
            ) : (
              <PrimaryBtn onClick={uploadBack} disabled={isProcessing}>
                {isProcessing ? 'Przetwarzanie…' : 'Skanuj tył dowodu'}
              </PrimaryBtn>
            )}

            {stepError && (
              <p style={{ marginTop: 10, fontSize: 12, color: 'var(--flag)', fontFamily: 'var(--mono)', textAlign: 'center' }}>
                {stepError}
              </p>
            )}
          </div>
        )}

        {/* ── Screen 2: Checking (auto, no user input) ────────────────── */}
        {screen === 'checking' && (
          <div key="checking" className="mv-fade-up" style={{
            ...screenStyle, alignItems: 'center', justifyContent: 'center', textAlign: 'center',
          }}>
            <AmbientGlow />

            <div style={{
              width: 80, height: 80, border: '2px solid var(--rule)',
              borderTopColor: 'var(--accent)', borderRadius: '50%',
              animation: 'spin 1s linear infinite', marginBottom: 18,
            }} />

            <p style={{ fontFamily: 'var(--sans)', fontSize: 16, fontWeight: 700, marginBottom: 6 }}>
              {checkingMsg}
            </p>
            <p style={{
              fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--mid)',
              letterSpacing: '0.08em',
            }}>To potrwa tylko chwilę</p>

            <div style={{ display: 'flex', gap: 8, marginTop: 24, flexWrap: 'wrap', justifyContent: 'center' }}>
              {['Dokument odczytany', 'Dane zgodne', 'Kontrole bezpieczeństwa'].map(tag => (
                <span key={tag} style={{
                  padding: '5px 10px',
                  background: 'var(--accent-soft)', border: '1px solid var(--rule)',
                  fontFamily: 'var(--mono)', fontSize: 10,
                  color: 'var(--accent-ink)',
                }}>{tag}</span>
              ))}
            </div>

            {stepError && (
              <p style={{ marginTop: 16, fontSize: 12, color: 'var(--flag)', fontFamily: 'var(--mono)' }}>
                {stepError}
              </p>
            )}
          </div>
        )}

        {/* ── Screen 3: Live Photo ────────────────────────────────────── */}
        {screen === 'live' && (
          <div key="live" className="mv-fade-up" style={screenStyle}>
            <AmbientGlow />

            {/* Active liveness (primary path) */}
            {!useFallbackSelfie && !selfieFile && !showSelfieCamera ? (
              <>
                <h1 style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.15, letterSpacing: '-0.01em', marginBottom: 8 }}>
                  Zdjęcie Twojej twarzy
                </h1>

                <p style={{ fontSize: 13, color: 'var(--mid)', lineHeight: 1.55, marginBottom: 12 }}>
                  Postępuj zgodnie z instrukcjami na ekranie — patrz w kamerę i obróć głowę, gdy pojawi się prośba.
                </p>

                {!showActiveLiveness ? (
                  <>
                    <TipBar text="Zdejmij okulary · Dobre światło · Bez nakrycia głowy" />
                    <div style={{ marginTop: 14 }} />
                    <PrimaryBtn onClick={() => setShowActiveLiveness(true)} disabled={isProcessing}>
                      Rozpocznij
                    </PrimaryBtn>
                  </>
                ) : (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                    <ActiveLivenessCapture
                      onComplete={handleActiveLivenessComplete}
                      onCancel={() => setShowActiveLiveness(false)}
                      onFallback={handleActiveLivenessFallback}
                      isProcessing={isProcessing}
                    />
                  </div>
                )}
              </>
            ) : (
              /* Fallback: legacy selfie capture */
              <>
                <h1 style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.15, letterSpacing: '-0.01em', marginBottom: 8 }}>
                  Zrób szybkie<br />selfie
                </h1>

                <p style={{ fontSize: 13, color: 'var(--mid)', lineHeight: 1.55, marginBottom: 12 }}>
                  Musimy potwierdzić, że Twoja twarz zgadza się z dowodem. Patrz prosto w kamerę w dobrze oświetlonym miejscu.
                </p>

                {/* Oval face viewfinder */}
                <OvalFaceViewfinder processing={isProcessing} previewUrl={selfiePreviewUrl} />

                {/* Liveness cues — hidden when processing */}
                <LivenessCues hidden={isProcessing} />

                <TipBar text="Zdejmij okulary · Dobre światło · Bez nakrycia głowy" />

                <div style={{ marginTop: 14 }} />

                {/* Hidden file input — capture="user" opens front camera on mobile */}
                <input type="file" accept="image/*" capture="user" id="mv-selfie-upload" style={{ display: 'none' }}
                  onChange={handleSelfieSelect} />

                {!selfieFile ? (
                  <PrimaryBtn
                    onClick={() => cameraSupported ? setShowSelfieCamera(true) : document.getElementById('mv-selfie-upload')?.click()}
                    disabled={isProcessing}
                  >
                    Zrób selfie
                  </PrimaryBtn>
                ) : (
                  <PrimaryBtn onClick={uploadSelfie} disabled={isProcessing}>
                    {isProcessing ? 'Przetwarzanie…' : 'Wyślij selfie'}
                  </PrimaryBtn>
                )}
              </>
            )}

            {stepError && (
              <p style={{ marginTop: 10, fontSize: 12, color: 'var(--flag)', fontFamily: 'var(--mono)', textAlign: 'center' }}>
                {stepError}
              </p>
            )}
          </div>
        )}

        {/* ── Guided Camera Overlay ─────────────────────────────────── */}
        {showCamera && (
          <IDCameraCapture
            variant={cameraVariant}
            onCapture={handleCameraCapture}
            onClose={handleCameraClose}
            onFallback={handleCameraFallback}
          />
        )}

        {/* ── Guided Selfie Camera Overlay ──────────────────────────── */}
        {showSelfieCamera && (
          <SelfieCameraCapture
            onCapture={handleSelfieCameraCapture}
            onClose={handleSelfieCameraClose}
            onFallback={handleSelfieCameraFallback}
          />
        )}

        {/* ── Screen 4: Voice ─────────────────────────────────────────── */}
        {screen === 'voice' && (
          <div className="mv-fade-up" style={{ padding: '0 24px', textAlign: 'center' }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--ink)', marginBottom: 4 }}>Speaker Verification</h2>
            <p style={{ fontSize: 12, color: 'var(--mid)', marginBottom: 16 }}>
              Speak the digits shown below into your microphone.
            </p>

            {/* Mic icon */}
            <div style={{
              width: 72, height: 72, borderRadius: '50%', margin: '0 auto 16px',
              border: `2px solid ${voiceIsRecording ? 'var(--accent, #22d3ee)' : 'var(--rule)'}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={voiceIsRecording ? 'var(--accent, #22d3ee)' : 'var(--mid)'} strokeWidth="1.5">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
            </div>

            {voiceChallengeDigits && (voiceExpiresIn === null || voiceExpiresIn > 0) && (
              <div style={{ padding: 12, border: '1px solid var(--rule)', borderRadius: 8, marginBottom: 16 }}>
                <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--mid)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  Speak these digits
                </div>
                <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '0.2em', color: 'var(--ink)' }}>
                  {voiceChallengeDigits}
                </div>
                {voiceExpiresIn !== null && (
                  <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: voiceExpiresIn < 30 ? '#ef4444' : 'var(--mid)', marginTop: 4 }}>
                    Expires in {voiceExpiresIn}s
                  </div>
                )}
              </div>
            )}

            {voiceIsRecording && <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--accent, #22d3ee)', marginBottom: 8 }}>Recording: {voiceRecordingDuration}s</p>}
            {voiceHasRecording && !voiceIsRecording && !isProcessing && <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#22c55e', marginBottom: 8 }}>Captured ({voiceRecordingDuration}s)</p>}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 280, margin: '0 auto' }}>
              {!voiceChallengeDigits && !isProcessing && (
                <PrimaryBtn onClick={handleVoiceChallenge}>Get Challenge</PrimaryBtn>
              )}
              {voiceChallengeDigits && !voiceIsRecording && !voiceHasRecording && (voiceExpiresIn === null || voiceExpiresIn > 0) && (
                <PrimaryBtn onClick={handleVoiceStartRecording}>Start Recording</PrimaryBtn>
              )}
              {voiceIsRecording && (
                <PrimaryBtn onClick={handleVoiceStopRecording}>Stop Recording</PrimaryBtn>
              )}
              {voiceHasRecording && !voiceIsRecording && !isProcessing && (
                <PrimaryBtn onClick={handleVoiceSubmit}>Wyślij nagranie</PrimaryBtn>
              )}
              {isProcessing && <div style={{ textAlign: 'center', padding: 8 }}><div className="mv-spinner" /></div>}
            </div>

            {stepError && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <p style={{ fontSize: 11, color: '#ef4444', fontFamily: 'var(--mono)' }}>{stepError}</p>
                <PrimaryBtn onClick={resetVoiceState}>Nagraj ponownie</PrimaryBtn>
              </div>
            )}
            {voiceChallengeDigits && voiceExpiresIn !== null && voiceExpiresIn <= 0 && !stepError && (
              <div style={{ marginTop: 8, maxWidth: 280, margin: '8px auto 0' }}>
                <PrimaryBtn onClick={() => { resetVoiceState(); handleVoiceChallenge(); }}>Request New Challenge</PrimaryBtn>
              </div>
            )}
          </div>
        )}

        {/* ── Screen 5: Complete ──────────────────────────────────────── */}
        {screen === 'done' && (
          <div key="done" className="mv-fade-up" style={{
            ...screenStyle, alignItems: 'center', justifyContent: 'center', textAlign: 'center',
          }}>
            <AmbientGlow />

            {!finalResult ? (
              /* Still polling for result */
              <>
                <div style={{
                  width: 80, height: 80, border: '2px solid var(--rule)',
                  borderTopColor: 'var(--accent)', borderRadius: '50%',
                  animation: 'spin 1s linear infinite', marginBottom: 18,
                }} />
                <p style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Processing your verification…</p>
                <p style={{
                  fontFamily: 'var(--mono)', fontSize: 11,
                  color: 'var(--mid)', letterSpacing: '0.08em',
                }}>{isDocumentOnly ? 'Finalizing your verification' : 'Analyzing your live photo'}</p>
              </>
            ) : (() => {
              const status = finalResult.final_result ?? finalResult.status;
              const isVerified = status === 'verified';
              const isFailed = status === 'failed';

              if (isVerified) {
                // Success state — the premium completion screen
                const checklist = isAgeOnly
                  ? [
                      'Dokument zeskanowany',
                      `Spełniono wymóg wieku (${finalResult.age_verification?.age_threshold ?? ageThreshold ?? 18}+)`,
                    ]
                  : isDocumentOnly
                  ? [
                      'Dokument tożsamości zweryfikowany',
                      'Dane dokumentu potwierdzone',
                    ]
                  : isIdentity
                  ? [
                      'Dokument tożsamości zweryfikowany',
                      'Test żywotności zaliczony',
                      'Twarz dopasowana',
                    ]
                  : [
                      'Dokument tożsamości zweryfikowany',
                      'Dane dokumentu potwierdzone',
                      'Test żywotności zaliczony',
                      'Twarz dopasowana',
                    ];
                return (
                  <>
                    {/* Success indicator */}
                    <div style={{
                      width: 112, height: 112,
                      border: '2px solid var(--accent)', background: 'var(--accent-soft)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 44, color: 'var(--accent)',
                      marginBottom: 20,
                    }}>✓</div>

                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: 10,
                      textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--accent)',
                      marginBottom: 8,
                    }}>{isAgeOnly ? 'Wiek potwierdzony' : isDocumentOnly ? 'Dokument zweryfikowany' : 'Weryfikacja zakończona'}</span>

                    <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 8 }}>
                      {pageConfig?.completionTitle || 'Gotowe!'}
                    </h1>

                    <p style={{ fontSize: 13, color: 'var(--mid)', lineHeight: 1.55, marginBottom: 24 }}>
                      {redirectUrl
                        ? 'Weryfikacja zakończona. Za chwilę wrócisz…'
                        : pageConfig?.completionMessage
                        ? pageConfig.completionMessage
                        : isAgeOnly
                        ? 'Twój wiek został potwierdzony. Możesz zamknąć tę kartę i wrócić do aplikacji.'
                        : isDocumentOnly
                        ? 'Twój dokument został zweryfikowany. Możesz zamknąć tę kartę i wrócić do aplikacji.'
                        : 'Twoja tożsamość została zweryfikowana. Możesz zamknąć tę kartę i wrócić do aplikacji.'}
                    </p>

                    {/* Checklist */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 320 }}>
                      {checklist.map((item, i) => (
                        <div key={i} style={{
                          display: 'flex', alignItems: 'center', gap: 11,
                          background: 'var(--accent-soft)', border: '1px solid var(--rule)',
                          padding: '11px 14px',
                          animation: `slideIn 0.3s ease ${i * 90}ms both`,
                        }}>
                          <span style={{ color: 'var(--accent)', fontSize: 14, flexShrink: 0 }}>✓</span>
                          <span style={{ fontSize: 13, color: 'var(--ink)' }}>{item}</span>
                        </div>
                      ))}
                    </div>

                    {patchFailed && (
                      <p style={{
                        marginTop: 16, fontSize: 11, color: 'var(--flag)',
                        fontFamily: 'var(--mono)',
                        background: 'var(--flag-soft)', border: '1px solid var(--rule)',
                        padding: '8px 12px',
                      }}>
                        Note: We couldn't notify your desktop automatically. Please refresh it to see your result.
                      </p>
                    )}

                    {redirectUrl && (
                      <p style={{ marginTop: 16, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--mid)', letterSpacing: '0.04em' }}>
                        Redirecting in 3 seconds…
                      </p>
                    )}
                  </>
                );
              }

              // Failed or manual review
              return (
                <>
                  <div style={{
                    width: 112, height: 112,
                    border: `1px solid ${isFailed ? 'var(--flag)' : 'var(--flag)'}`,
                    background: isFailed ? 'var(--flag-soft)' : 'var(--flag-soft)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 44, color: 'var(--flag)', marginBottom: 20,
                  }}>
                    {isFailed ? '✕' : '?'}
                  </div>

                  <h1 style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em', marginBottom: 8 }}>
                    {isFailed
                      ? isAgeOnly ? 'Weryfikacja wieku nieudana' : isDocumentOnly ? 'Weryfikacja dokumentu nieudana' : 'Weryfikacja nieudana'
                      : 'W trakcie przeglądu'}
                  </h1>

                  <p style={{ fontSize: 13, color: 'var(--mid)', lineHeight: 1.55, marginBottom: 16 }}>
                    {isFailed
                      ? isAgeOnly
                        ? (finalResult.message || 'Nie udało się zweryfikować wieku.')
                        : 'Nie udało się zweryfikować Twojej tożsamości. Spróbuj ponownie z lepszym zdjęciem.'
                      : 'Twoja weryfikacja jest sprawdzana. Powiadomimy Cię o wyniku.'}
                  </p>

                  {(() => {
                    const hint = isFailed ? getFailureHint(finalResult) : null;
                    return hint ? (
                      <div style={{
                        width: '100%', maxWidth: 340, marginBottom: 16,
                        padding: '12px 14px', borderRadius: 10, textAlign: 'left',
                        background: 'var(--accent-soft)', border: '1px solid var(--rule)',
                      }}>
                        <div style={{ fontFamily: 'var(--sans)', fontSize: 11, fontWeight: 700, color: 'var(--accent-ink)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                          Co poprawić
                        </div>
                        <div style={{ fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--ink)', lineHeight: 1.5 }}>
                          {hint}
                        </div>
                      </div>
                    ) : null;
                  })()}

                  {isFailed && finalResult.retry_available !== false && isLivenessStageFailure(finalResult) && (
                    <div style={{ marginTop: 16, width: '100%', maxWidth: 320 }}>
                      <PrimaryBtn onClick={handleRetryLiveness} disabled={retryProcessing}>
                        {retryProcessing ? 'Ponawianie…' : 'Powtórz zdjęcie twarzy'}
                      </PrimaryBtn>
                      <button
                        onClick={handleRetry}
                        disabled={retryProcessing}
                        style={{
                          marginTop: 10, width: '100%', background: 'none', border: 'none',
                          color: 'var(--mid)', fontFamily: 'var(--sans)', fontSize: 12,
                          textDecoration: 'underline', cursor: retryProcessing ? 'default' : 'pointer',
                        }}
                      >
                        Zacznij od nowa (skan dowodu)
                      </button>
                    </div>
                  )}
                  {isFailed && finalResult.retry_available !== false && !isLivenessStageFailure(finalResult) && (
                    <div style={{ marginTop: 16, width: '100%', maxWidth: 320 }}>
                      <PrimaryBtn onClick={handleRetry} disabled={retryProcessing}>
                        {retryProcessing ? 'Ponawianie…' : 'Spróbuj ponownie'}
                      </PrimaryBtn>
                    </div>
                  )}
                  {isFailed && finalResult.retry_available === false && (
                    <p style={{
                      marginTop: 16, fontSize: 11, color: 'var(--flag)',
                      fontFamily: 'var(--mono)',
                    }}>
                      Osiągnięto maksymalną liczbę prób.
                    </p>
                  )}

                  {patchFailed && (
                    <p style={{
                      fontSize: 11, color: 'var(--flag)',
                      fontFamily: 'var(--mono)',
                      background: 'var(--flag-soft)', border: '1px solid var(--rule)',
                      padding: '8px 12px',
                    }}>
                      Uwaga: nie udało się automatycznie powiadomić Twojego urządzenia. Odśwież je, aby zobaczyć wynik.
                    </p>
                  )}

                  {redirectUrl && (
                    <p style={{ marginTop: 16, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--mid)', letterSpacing: '0.04em' }}>
                      Przekierowanie za 3 sekundy…
                    </p>
                  )}
                </>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
};

export default MobileVerificationPage;
