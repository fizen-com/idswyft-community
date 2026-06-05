# Przebieg weryfikacji i wyniki

## Pipeline (5-krokowy automat stanów)
```
AWAITING_FRONT → AWAITING_BACK → CROSS_VALIDATING → AWAITING_LIVE → FACE_MATCHING → COMPLETE
                                                                                   → HARD_REJECTED
```

| Krok | Endpoint | Co się dzieje |
|------|----------|---------------|
| 1 | `POST /api/v2/verify/initialize` | utworzenie sesji (zwraca `verification_id`, `session_token`, `verification_url`) |
| 2 | `POST /api/v2/verify/:id/front-document` | OCR przodu, detekcja twarzy, tamper detection |
| 3 | `POST /api/v2/verify/:id/back-document` | barcode/MRZ + auto cross-validation przód↔tył |
| 4 | `POST /api/v2/verify/:id/live-capture` | liveness (head-turn) + auto face match |
| 5 | `GET /api/v2/verify/:id/status` | poll wyniku końcowego |

Tryby (`verification_mode` przy initialize): `full` (dokument + liveness + face match), `document_only` (sam dokument), `identity`, `age_only`.

**Inwariant architektoniczny:** wszystkie decyzje pass/fail/review są **deterministyczne i audytowalne** (checksumy, exact match, Levenshtein, cosine z progami). LLM może tylko czytać tekst z obrazów (OCR) — nigdy decydować.

---

## Wyniki końcowe (`final_result`)
| Wynik | Znaczenie | Akcja PYK |
|-------|-----------|-----------|
| `verified` | wszystkie bramki przeszły automatycznie | wpuść usera |
| `failed` | twarda bramka odrzuciła (HARD_REJECTED) | retry / blok |
| `manual_review` | przeszło twarde bramki, ale coś graniczne → decyzja człowieka (MLRO) | HOLD → MLRO approve/reject |

### Co wyzwala `manual_review` (`needsManualReview`)
- `cross_validation.verdict === 'REVIEW'` — dane przód↔tył częściowo zgodne / barcode nieczytelny (środkowe pasmo)
- face match pominięty (`skipped_reason`)
- flagi **velocity** (np. `rapid_ip_reuse` — dużo prób z tego samego IP)
- flagi **geo** (np. `country_mismatch`)
- duplikat (dedup) — ta sama twarz/dokument u innego usera (flaga, nie twardy blok)
- reguła compliance `force_manual_review` / trafienie AML (sankcje)

### Co wyzwala `failed` (HARD_REJECTED)
- liveness failed (anti-spoofing)
- krytyczna niezgodność cross-validation (np. numer/imię/data przód ≠ tył)
- dokument przeterminowany
- face match failed (selfie ≠ zdjęcie z dowodu)
- tamper/deepfake
- duplikat z twardym blokiem

> Uwaga testowa: powtarzane testy z tego samego IP/lokalizacji generują flagi velocity/geo → `manual_review`. To artefakt testów, nie zachowanie realnego usera.

---

## Cross-validation (krok 3)
Porównuje pola przód↔tył z wagami; krytyczne pola muszą się zgadzać.
- `field_scores`: `id_number` (waga 0.4), `full_name` (0.25), `date_of_birth` (0.2), `expiry_date` (0.1), `nationality` (0.05).
- `verdict`: `PASS` / `REVIEW` / `REJECT`; `has_critical_failure` → REJECT.
- Nasza modyfikacja: „MISSING ON BACK" (tył nieczytelny) nie blokuje, gdy przód ma dane. Ale gdy **przód** sam nie wyczytał krytycznego pola (słabe zdjęcie) → REJECT.

**Najczęstsza przyczyna `failed` przed liveness:** słaby skan — OCR nie wyczytał daty/imion z przodu lub MRZ z tyłu → krytyczna niezgodność. Rozwiązanie: lepsze zdjęcie (płasko, światło, ostro, cała karta + MRZ) i „Try Again".

---

## Liveness (krok 4) — head-turn
Przeglądarka łapie klatki, wysyła je w `liveness_metadata` (base64) + jedno zdjęcie `selfie`. Engine liczy score (kąty yaw) i **odrzuca klatki** — trwale zapisuje **tylko obraz live-capture** + score/metadane. **Brak wideo.**

Checki (suma wag 1.0, próg PASS 0.60): face_present (0.15), head_turn ≥5° (0.25), correct_direction (0.20), return_to_center ≤15° (0.15), temporal 8–90s (0.08), bbox_consistency (0.07), virtual_camera_not_detected (0.10).

`MIN_YAW_DELTA=5°` (obniżone — 2D yaw zaniża realny obrót). Jeśli realny obrót nadal nie przechodzi → patrz CUSTOMIZATIONS.md §3.

---

## Co zwraca `GET /status` (kluczowe pola)
```json
{
  "final_result": "verified|failed|manual_review|null",
  "status": "...", "current_step": n, "total_steps": n,
  "ocr_data": { "name", "document_number", "date_of_birth", "expiry_date", "issuing_country", "nationality" },
  "barcode_data": { "pesel": "85071918472", ... },   // PESEL TUTAJ
  "cross_validation_results": { "verdict", "field_scores", "has_critical_failure" },
  "liveness_results": { "passed", "score", "checks" },
  "face_match_passed": true, "liveness_passed": true,
  "rejection_reason", "rejection_detail", "manual_review_reason"
}
```

## Restart po porażce
`POST /api/v2/verify/:id/restart` (API key lub handoff token) — reset do `AWAITING_FRONT`, `retry_count++`, kasuje dokumenty/selfie. Limit **10** prób. We froncie mobilnym: przycisk „Try Again" robi to bez nowego linku. (Wymaga kolumny `completed_at` — patrz CUSTOMIZATIONS.md §7.)
