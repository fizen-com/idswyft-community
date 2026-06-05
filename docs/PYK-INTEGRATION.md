# idswyft ↔ PYK — kontrakt integracji (preprod)

Autorytatywny kontrakt po stronie idswyft dla integracji KYC z PYK.
Wszystkie wartości dotyczą środowiska **preprod**. Zweryfikowane na żywo 2026-06-03.

## Środowiska / URL-e

| Rola | URL |
|------|-----|
| idswyft API | `https://idswyft-api-preprod.fly.dev` |
| idswyft Web (hosted UI) | `https://idswyft-web-preprod.fly.dev` |
| idswyft Engine (ML) | `https://idswyft-engine-preprod.fly.dev` (wewnętrzny) |
| PYK API | `https://pyk-api-preprod.fly.dev` |

> Web preprod ma `auto_stop_machines` + `min_machines_running=0` → pierwsze otwarcie
> `verification_url` budzi maszynę (cold start ~kilka sekund). To normalne.

## Sekrety (preprod)

| Nazwa | Wartość |
|-------|---------|
| `IDSWYFT_URL` | `https://idswyft-api-preprod.fly.dev` |
| `IDSWYFT_API_KEY` | `ik_307eb9acc5192d1721a3693265d4aadabe94bc8f4bf3f14089f74e8798185363` |
| `IDSWYFT_WEBHOOK_SECRET` | `whsec_602d2fb912d42b683c74d83c48ef25b24a4c35cfbceb6353` |

- Klucz API: scope **production** (`is_sandbox=false`), aktywny, należy do developera
  `maciej@fizen.com` (`230e9b57-59e0-47fa-8619-bb1d2009a064`).
- Webhook i klucz API muszą mieć ten sam scope sandbox — oba są `production`. ✅

## Auth

Wszystkie wywołania serwer-serwer z PYK → idswyft:
```
X-API-Key: ik_307eb9...
```

## Flow

```
PYK API  --POST /api/v2/verify/initialize-->  idswyft  (zwraca verification_id + verification_url)
PYK zapisuje verification_id przy user-ze (klucz korelacji!)
PYK Mobile WebView --otwiera--> verification_url  (hosted UI idswyft: skan dokumentu [+ liveness])
idswyft --POST signed webhook--> PYK /api/webhooks/idswyft  (status terminalny)
PYK opcjonalnie --GET /status--> idswyft  (po PESEL i pełne OCR)
```

## 1. Initialize — `POST /api/v2/verify/initialize`

Body:
```json
{
  "user_id": "<UUID użytkownika PYK>",      // WYMAGANE, musi być poprawnym UUID
  "document_type": "national_id",            // dla dowodu PL
  "issuing_country": "PL",                    // 2-literowy ISO; dla PL ZAWSZE podawaj
  "verification_mode": "document_only"        // lub "full" (z liveness/face match)
}
```
- `user_id` to UUID użytkownika **w bazie PYK**. idswyft **auto-tworzy** swój wpis usera
  przy pierwszym wywołaniu — nie trzeba go zakładać wcześniej (zweryfikowane: świeży losowy UUID → 201).
- `issuing_country: "PL"` jest istotne — polski dowód ma MRZ tylko z tyłu, więc bez jawnego
  kraju auto-detekcja z przodu nie zadziała. Zawsze wysyłaj `PL` (override per user na przyszłość).

Odpowiedź (201):
```json
{
  "success": true,
  "verification_id": "bdbc4e96-...",
  "session_token": "165b99...",
  "verification_url": "https://idswyft-web-preprod.fly.dev/user-verification?session=165b99...",
  "verification_mode": "document_only",
  "status": "AWAITING_FRONT",
  "current_step": 1,
  "total_steps": 3
}
```
- **`verification_id`** — ZAPISZ przy user-ze. To klucz korelacji webhooka (patrz niżej).
- **`verification_url`** — otwórz w WebView mobile. (Po naprawie `FRONTEND_URL` wskazuje już na web, nie na API.)

## 2. Webhook — idswyft → `POST https://pyk-api-preprod.fly.dev/api/webhooks/idswyft`

Już zarejestrowany. idswyft wysyła na zdarzenia: `verification.started`,
`verification.document_processed`, `verification.completed`, `verification.failed`,
`verification.manual_review`, `document.expiry_warning`, `verification.reverification_due`.
PYK ignoruje nieterminalne; reaguje na completed/failed/manual_review.

Nagłówek podpisu:
```
X-Idswyft-Signature: sha256=<hex HMAC-SHA256(rawBody, IDSWYFT_WEBHOOK_SECRET)>
```
- Podpis liczony nad **dokładnym surowym ciałem** żądania (tym samym stringiem, który idswyft
  wysyła). PYK **musi** hashować surowy body (nie re-serializować JSON). ✅ Zweryfikowane na żywo:
  poprawnie podpisany payload → `200 {received:true}`; bez/zły podpis → `401 Invalid signature`.
- Inne nagłówki: `X-Idswyft-Sandbox`, `X-Idswyft-Verification-Mode` (`production`/`sandbox`),
  `X-Idswyft-Webhook-Id`, `X-Idswyft-Delivery-Attempt`.

Body webhooka:
```json
{
  "event": "verification.completed",                 // | verification.failed | verification.manual_review
  "user_id": "<UUID usera PYK>",
  "verification_id": "<UUID weryfikacji idswyft>",   // korelacja
  "status": "verified",                               // | failed | manual_review
  "timestamp": "2026-06-03T...Z",
  "data": {
    "ocr_data": { "name": "...", "document_number": "...", "date_of_birth": "...",
                  "expiry_date": "...", "issuing_country": "PL", "nationality": "..." },
    "face_match_score": 0.91,
    "failure_reason": "..."
  }
}
```

> ⚠️ **PESEL NIE jest w webhooku.** Payload niesie tylko `data.ocr_data` (+face score+failure).
> PESEL jest w `barcode_data.pesel` — pobierz przez `GET /status` (patrz niżej). AML art. 36.

Korelacja: PYK znajduje sesję po **`verification_id`** (potwierdzone — payload z nieznanym
`verification_id` zwraca `{received:true, ignored:true}`). Dlatego zapisuj `verification_id` w kroku init.

Dostawa webhooka jest fire-and-forget z retry (idswyft ponawia na 5xx). Zwracaj 2xx po
zweryfikowaniu podpisu, nawet gdy ignorujesz payload.

## 3. Status — `GET /api/v2/verify/:verification_id/status`

Auth: `X-API-Key`. Zwraca pełny obiekt; istotne pola:
```json
{
  "final_result": "verified",                  // | failed | manual_review | null (w toku)
  "status": "...", "current_step": n, "total_steps": n,
  "ocr_data": { "name": "...", "document_number": "DFF362754", "date_of_birth": "1985-07-19",
                "expiry_date": "2032-09-07", "issuing_country": "PL", "nationality": "..." },
  "barcode_data": { "pesel": "85071918472", ... },   // ← PESEL TUTAJ (AML art. 36)
  "face_match_passed": true, "liveness_passed": true,
  "cross_validation_results": {...},
  "manual_review_reason": "...", "failure_reason": "..."
}
```
- Po terminalnym webhooku zrób jeden `GET /status` aby pobrać `barcode_data.pesel`
  i pełne `ocr_data`. Obsłuż `pesel == null` (słaba jakość tyłu) → manual / doczytanie.

## 4. Media retrieval (compliance) — `GET /api/v2/verify/:id/media`

Auth: `X-API-Key` (developer-scoped). Returns a manifest of stored evidence:
```json
{
  "success": true,
  "verification_id": "...",
  "artifacts": [
    {"type":"front","file_name":"id-front-....jpg","download_url":".../media/front"},
    {"type":"back","file_name":"id-back-....jpg","download_url":".../media/back"},
    {"type":"live_capture","file_name":"selfie.jpg","download_url":".../media/live-capture"}
  ],
  "liveness": {"passed": true, "score": 0.9, "type": "head_turn"},
  "note": "Liveness is a still live-capture image; video recording is not stored."
}
```
Download bytes: `GET /api/v2/verify/:id/media/:artifact` where artifact ∈ `front|back|live-capture`
→ streams the image (`Content-Type: image/jpeg`, `Content-Disposition: inline`).

> ⚠️ **No liveness VIDEO.** idswyft processes head-turn frames in-memory for scoring and
> persists only ONE live-capture image + the liveness score/metadata. There is no video file.
> ⚠️ **Pull media promptly** — files are removed by retention (`DATA_RETENTION_DAYS`) and
> immediately on HARD_REJECT. Best: fetch media right after the `verification.completed` webhook.

## Uwagi / pułapki

- **document_only vs full**: dla `document_only` consistency-monitor nie resetuje już `verified`
  (poprawione). `full` wymaga ukończenia liveness + face match.
- **Pola OCR**: nazewnictwo `name`/`document_number` (nie `full_name`/`id_number`).
- **PL produkcyjnie przetestowane**: dowód osobisty (PASS). Prawo jazdy/paszport skonfigurowane,
  nie w pełni przetestowane E2E.
- **CORS** idswyft API zawiera już `pyk-web-preprod` i `pyk-api-preprod` (server-serwer i tak nie wymaga CORS).

## Stan na 2026-06-03

- [x] API key produkcyjny działa (auto-create usera po UUID z PYK)
- [x] `FRONTEND_URL` ustawione → `verification_url` poprawne
- [x] Webhook zarejestrowany, podpis zgodny end-to-end (200/401 potwierdzone)
- [x] PYK `/api/webhooks/idswyft` żyje i weryfikuje podpis
- [ ] Pełny przebieg E2E z realnym skanem (dokument + ew. liveness) → completed webhook → update usera w PYK
