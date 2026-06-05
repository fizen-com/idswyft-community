# idswyft @ Fizen/PYK — Dokumentacja

Wewnętrzna dokumentacja wdrożenia i integracji idswyft (KYC/weryfikacja tożsamości) dla PYK.
Repo: fork `fizen-com/idswyft-community` (z `team-idswyft/idswyft-community`, baza v1.12.7).

## Spis dokumentów
| Dokument | Zawartość |
|----------|-----------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Architektura obu środowisk: preprod (Fly.io) i prod (GCP) — komponenty, sieć, storage, sekrety |
| [PYK-INTEGRATION.md](PYK-INTEGRATION.md) | Kontrakt integracji idswyft↔PYK: auth, endpointy, webhook, media, PESEL |
| [CUSTOMIZATIONS.md](CUSTOMIZATIONS.md) | Wszystkie nasze zmiany w kodzie (PL OCR, liveness, Page Builder, retry, /media, PESEL) z odnośnikami do commitów i plików |
| [VERIFICATION-FLOW.md](VERIFICATION-FLOW.md) | Pipeline weryfikacji, wyniki (verified/failed/manual_review), liveness, cross-validation |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Deploy preprod (Fly), sync prod (GCP), migracje, build |
| [OPERATIONS.md](OPERATIONS.md) | Runbook: OTP/email, logi, restart, capacity, znane pułapki, audyt schematu |

## System w skrócie
idswyft = open-source platforma weryfikacji tożsamości. Developer integruje się przez API: skan dowodu (OCR), cross-validation przód↔tył, liveness (head-turn), face match. Architektura: **API (orchestrator)** + **engine (ML: OCR/face/liveness)** + **frontend (hosted UI)** + **Postgres**.

**Po co nam:** KYC w PYK (onboarding/AML). PYK woła API idswyft, user robi weryfikację w hosted UI idswyft, idswyft webhookuje wynik do PYK.

## Szybki przegląd środowisk

### Preprod — Fly.io (region fra)
| Serwis | URL |
|--------|-----|
| API | `https://idswyft-api-preprod.fly.dev` |
| Web (hosted UI) | `https://idswyft-web-preprod.fly.dev` |
| Engine | `https://idswyft-engine-preprod.fly.dev` (wewn.) |
| DB | Fly Postgres `idswyft-db-preprod` |
| PYK API (cel webhooka) | `https://pyk-api-preprod.fly.dev/api/webhooks/idswyft` |

### Prod — GCP (projekt `idswyft-production`, region europe-central2)
| Serwis | URL / zasób |
|--------|-------------|
| Web | `https://kyc.fizen.com` |
| API | `https://kyc-api.fizen.com` |
| Engine | Cloud Run `idswyft-engine` (internal) |
| DB | GCE VM `idswyft-postgres` (Postgres 16 w kontenerze, 10.10.0.2) |
| LB IP | `8.233.246.51` (Global HTTPS LB, managed cert) |

## Sekrety / klucze (preprod)
| Co | Wartość |
|----|---------|
| API key (PYK) | `ik_307eb9acc5192d1721a3693265d4aadabe94bc8f4bf3f14089f74e8798185363` |
| Webhook secret | `whsec_602d2fb912d42b683c74d83c48ef25b24a4c35cfbceb6353` |
| Developer | `maciej@fizen.com` (id `230e9b57-59e0-47fa-8619-bb1d2009a064`) |
| Email | Resend, `EMAIL_FROM=Fizen <noreply@fizen.com>` (domena fizen.com verified) |

> ⚠️ Powyższe to sekrety środowiska preprod. Prod ma własne (Secret Manager) — patrz ARCHITECTURE.md.

## Najważniejsze fakty operacyjne
- **Tylko 🇵🇱 dowód osobisty** jest przetestowany E2E. Zawsze przekazuj `issuing_country: "PL"` przy `initialize` (polski MRZ jest tylko z tyłu → bez kraju auto-detekcja zawodzi).
- **PESEL**: nie w webhooku — w `GET /status` → `barcode_data.pesel` (AML art. 36).
- **Liveness = obraz + score**, NIE wideo (idswyft nie nagrywa wideo).
- **Wyniki**: `verified` / `failed` / `manual_review` — patrz VERIFICATION-FLOW.md.
