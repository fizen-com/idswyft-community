# Customizacje (zmiany vs upstream idswyft)

Wszystkie zmiany są na `fizen-com/idswyft-community` branch `main` (= preprod). Baza: upstream v1.12.7 (`4ced010 sync: mirror from idswyft @ v1.12.7`).

Commity (chronologicznie):
| Commit | Temat |
|--------|-------|
| `6120589` | Polish ID support + wdrożenie Fly preprod |
| `d6c64e5` | Ekstrakcja + walidacja PESEL (AML art. 36) |
| `bc3b903` | Fix CI (test HeadTurnVerifier, npm audit) |
| `d7e2b75` | Endpointy `/media` (compliance) |
| `3082085` | PL UX + reliability (liveness, nationality, Page Builder mobile, retry, migracja completed_at) |
| `253b8ca` | Liveness-only retry + PL-ID-SPEC.md (wzór Dz.U. 2025 poz. 1031) + batch PYK UI/OCR |

---

## 1. Obsługa polskiego dowodu (OCR/ekstrakcja) — `6120589`

**Problem:** upstream nie miał formatu PL; polski dowód ma MRZ tylko z tyłu, etykiety po polsku, numer dokumentu ze sklejonym „M" (płeć), datę urodzenia w jednej linii z obywatelstwem.

**Zmiany:**
- `shared/src/providers/ocr/internationalIdFormats.ts` — **dodany format `PL`** (national_id, drivers_license, passport): polskie etykiety (`NAZWISKO`, `IMIONA`, `SERIA I NUMER`, `DATA URODZENIA`, `TERMIN WAŻNOŚCI`…), regex numeru `^[A-Z]{3}\d{6}$` (dowód), `^[A-Z]{2}\d{7}$` (paszport), tolerancja ogonków w regexpach (`[żz]`, `[śs]`, `[ąa]`).
- `engine/src/routes/extract.ts` — fallbacki PL: wyciąganie numeru `DFF362754` i imienia z raw text gdy `findField` zawiedzie; OCR tyłu zawsze odpalany (dla MRZ); priorytet MRZ nad barcode PESEL.
- `engine/src/services/mrz.ts` + `backend/src/services/mrz.ts` — tolerancja obciętych linii MRZ, normalizacja `0→O` w kodzie kraju (np. `P0L→POL`), trim linii do 30/36/44 znaków, próg roku (`yy≤50`→2000s, żeby `2032` nie był `1932`).
- `backend/src/verification/cross-validator/{config,engine,normalizers}.ts` — „MISSING ON BACK" nie blokuje (gdy tył nieczytelny, a przód ma dane); mapowanie `POLSKIE→POL`.
- `backend/src/.../NationalIdExtractor.ts` — polskie etykiety.

**Jak używać:** zawsze przekazuj `issuing_country: "PL"` przy `initialize`. Bez tego engine idzie ścieżką `auto` i nie wyciąga numeru/imienia z polskiego przodu (MRZ tylko z tyłu).

**Kraje obsługiwane** (z formatami etykiet): GB, CA, AU, NZ, DE, FR, HT, IT, ES, NL, AL, BR, MX, AR, JP, KR, IN, SG, PH, TH, VN, **PL** (dodane). US osobno (AAMVA barcode).

---

## 2. PESEL (AML art. 36) — `d6c64e5`

**Problem:** PESEL (11 cyfr) jest na tyle dowodu w barcode, ale engine go ignorował jako szum. AML wymaga PESEL osobno od numeru dokumentu.

**Zmiany:**
- `engine/src/routes/extract.ts` — wyciąganie PESEL z raw text tyłu → `barcode_data.pesel`.
- `shared/src/verification/models/schemas.ts` — `pesel` w schemacie (`.passthrough()` przepuszcza).

**Gdzie jest PESEL:** `GET /api/v2/verify/:id/status` → `barcode_data.pesel`. **NIE w webhooku** (payload niesie tylko `ocr_data`).

---

## 3. Liveness — łagodniejszy próg — `6120589` + `3082085`

**Problem:** head-turn liczy yaw z 2D landmarków (nos + kąciki oczu) — **zaniża** realny obrót głowy. Próg 12°, potem 8° wciąż oblewał realne twarze (score 0.55 vs próg 0.60).

**Zmiany** (`shared/src/providers/liveness/HeadTurnVerifier.ts`, liveness liczy się w **engine**):
- `MIN_YAW_DELTA`: 12° → 8° → **5°**. To naprawia sprzężone checki `head_turn_detected` (0.25) + `correct_direction` (0.20).
- `RETURN_YAW_TOLERANCE`: 8° → 15°.
- `PASS_THRESHOLD` = 0.60 (bez zmian — świadoma decyzja).

Wagi checków: face_present 0.15, head_turn 0.25, correct_direction 0.20, return_to_center 0.15, temporal 0.08, bbox 0.07, virtual_camera 0.10. Suma 1.0.

---

## 4. Obywatelstwo — strip sklejonej daty — `3082085`

**Problem:** polski dowód ma `OBYWATELSTWO/NATIONALITY` i `DATA URODZENIA` w jednym wierszu → OCR zwracał `nationality: "POLSKIE 19.07.1985"`.

**Zmiana** (`engine/src/providers/ocr/PaddleOCRProvider.ts`): w czyszczeniu `nationality` dodany strip końcowej daty (`dd.mm.yyyy / dd/mm/yyyy / dd-mm-yyyy`) → `"POLSKIE"`.

---

## 5. Endpointy media (compliance) — `d7e2b75`

**Problem:** media (zdjęcia dowodu, live-capture) zwracał tylko panel admina (admin/reviewer JWT). PYK (API key) nie miał dostępu; `/status` zwraca tylko flagi `*_uploaded`, bez URL-i.

**Zmiany** (`backend/src/routes/newVerification.ts`):
- `GET /api/v2/verify/:id/media` — manifest: front/back/live_capture (download_url) + liveness score.
- `GET /api/v2/verify/:id/media/:artifact` (`front|back|live-capture`) — strumieniuje obraz (Content-Type, owner-scoped).
- Auth: `X-API-Key` + sprawdzenie właściciela. Przód/tył po kolejności uploadu (front pierwszy).

**Ważne:** brak wideo liveness — tylko obraz live-capture + score. Media kasowane przez retencję / HARD_REJECT → pobierać szybko po webhooku.

---

## 6. Page Builder na flow mobilnym — `3082085`

**Problem:** Page Builder (config per-developer: kolory/font/etykiety/nagłówek/completion) był stosowany tylko na desktopowym inline flow. Na telefonie `/user-verification` przekierowuje na `/verify/mobile`, który **ignorował** config → czarny ekran zamiast skonfigurowanego.

**Zmiany:**
- `backend/src/routes/handoff.ts` — `/api/verify/handoff/:token/session` zwraca teraz `page_builder_config` (resolved z developera).
- `frontend/src/pages/MobileVerificationPage.tsx` — stosuje config: `data-theme` + nadpisanie CSS vars (`--paper/--panel/--ink/--accent/--sans`) zakresowane do aktywnego motywu, lokalizacja etykiet kroków (`config.steps`), tytuł/podtytuł (headerTitle/headerSubtitle), ekran końcowy (completionTitle/Message).

**Granice:** Page Builder steruje tylko: kolory, font, etykiety kroków, header, completion, confetti, powered-by. **Nie** zmienia instrukcji per-ekran („Scan the front…"), etykiet CHECKING/COMPLETE ani layoutu kreatora aparatu. Podgląd w builderze to osobny mockup, nie realny flow.

---

## 7. Restart/retry — koniec dead-endu — `3082085`

**Problem:** po nieudanej weryfikacji „Try Again" nie działał (klik nic nie robił), refresh → „unable to load".
**Dwie przyczyny:**
1. Przycisk pokazywał się tylko gdy `retry_available === true`, a odpowiedź cross-val nie miała tego pola.
2. **`/restart` zwracał ciche 409** — restart-UPDATE pisał do kolumny `verification_requests.completed_at`, której **żadna migracja nie tworzy** (kod idswyft pisze niezadeklarowaną kolumnę; Supabase połyka błąd → 0 wierszy → 409).

**Zmiany:**
- `backend/src/routes/newVerification.ts` — limit prób 3 → **10**.
- `backend/src/verification/statusReader.ts` — `retry_available` próg < 10.
- `frontend/src/pages/MobileVerificationPage.tsx` — „Try Again" pokazuje się gdy retry nie jest jawnie wyczerpany (`!== false`).
- `supabase/migrations/61_add_verification_completed_at.sql` — **dodaje `verification_requests.completed_at`** (trwały fix; preprod dostał też ręczny `ALTER`).

> Ten bug jest też na prodzie (prod DB nie ma jeszcze `completed_at`) — patrz DEPLOYMENT.md, krok migracji.

---

## 7b. Liveness-only retry (powtórka samego live capture)

**Problem:** gdy dokumenty przeszły, a weryfikacja padła dopiero na liveness/face-match,
„Spróbuj ponownie" kasował cały skan i kazał robić dowód od zera. Dowód był dobry — padła
tylko twarz/ruch głowy.

**Rozwiązanie:** nowy endpoint resetuje sesję do `AWAITING_LIVE` **bez** kasowania
zeskanowanego dokumentu — user powtarza tylko zdjęcie twarzy.

**Endpoint:** `POST /api/v2/verify/:id/restart-liveness` (auth: API key lub handoff token).
- **Gating:** tylko `final_result === 'failed'` i gdy dokumenty przeszły (`front_extraction`
  obecne, `cross_validation` nie REJECT / bez `has_critical_failure`). Inaczej
  `400 LIVENESS_RETRY_NOT_ELIGIBLE` → klient ma użyć pełnego `/restart`.
- **Re-ekstrakcja twarzy z dowodu:** embedding twarzy z przodu jest **strippowany na stanie
  terminalnym** (GDPR Art. 9). Endpoint **re-ekstrahuje** embedding z zapisanego obrazu przodu
  (`extractFront`) i wstawia tylko `front_extraction.face_embedding` (OCR bez zmian). Inwariant
  GDPR zachowany — `saveSessionState` ponownie strippuje na kolejnym stanie terminalnym
  (AWAITING_LIVE nie jest terminalny). Gdy re-ekstrakcja zawiedzie → face match →
  `manual_review` (bezpiecznie).
- **Reset:** czyści tylko wyjścia etapu live (`face_match`, `liveness`, `deepfake_check`,
  `age_estimation`, `voice_match`, `velocity_analysis`, `geo_analysis`, scores, `selfie_id`,
  `duplicate_flags`); kasuje `selfies`, `verification_risk_scores`, odcisk `face_lsh`
  (zostawia `documents`, `verification_contexts`, odcisk `document_phash`). Współdzielony
  `retry_count` (limit 10), optimistic lock, reset handoff session — jak `/restart`.

**Zmiany:**
- `backend/src/routes/newVerification.ts` — endpoint `POST /:id/restart-liveness`.
- `frontend/src/pages/MobileVerificationPage.tsx`:
  - `isLivenessStageFailure(fr)` — rozpoznaje porażkę etapu live (`LIVENESS_FAILED`,
    `FACE_NOT_DETECTED`, `FACE_MATCH_FAILED`, `DEEPFAKE_DETECTED`, `liveness_passed===false`,
    `face_match_passed===false`).
  - `handleRetryLiveness()` — woła `/restart-liveness`, resetuje tylko stan selfie, skacze na
    ekran `live`; na `400` robi fallback do pełnego `handleRetry()`.
  - Ekran wyniku: porażka etapu live → przycisk **„Powtórz zdjęcie twarzy"** + link
    **„Zacznij od nowa (skan dowodu)"**; inaczej zwykłe „Spróbuj ponownie".

**Przy okazji:** naprawiony pre-existing czerwony test `HeadTurnVerifier.test.ts` (`MIN_YAW_DELTA`
obniżony 8→5 wcześniej, test wciąż używał yaw=5 jako „insufficient" → zmienione na 3).

---

## 8. Infrastruktura / konfiguracja (nie-kodowe)
- `fly.{api,engine,frontend}.toml`, `Dockerfile.frontend`, `frontend/nginx.fly.conf` — wdrożenie preprod (`6120589`).
- `deploy/gcp/*` (niezacommitowane): `cloudbuild.{engine,api,web}.yaml`, `deploy-prod.sh`, `pg-startup.sh`, `README.md`; `Dockerfile.web.gcp`, `frontend/nginx.gcp.conf` — wdrożenie prod GCP.
- Sekrety Fly preprod: `FRONTEND_URL`, `CORS_ORIGINS`, `RESEND_API_KEY`, `EMAIL_FROM` (ustawiane przez `fly secrets set`, nie w gicie).

---

## Znane bugi upstream wykryte przy okazji
- **`completed_at`**: kod (`newVerification.ts` restart + finalize, session state) pisze kolumnę `verification_requests.completed_at`, której nie ma w migracjach → ciche błędy (Supabase client ignoruje `error`). Fix: migracja 61. **Wzorzec ryzyka:** inne `.update()/.insert()` z literówką/niezadeklarowaną kolumną padną tak samo cicho.
- **Audyt schematu** (OPERATIONS.md) potwierdził: preprod DB = migracje (0 dryfu); `completed_at` to jedyny code-vs-schema mismatch.
