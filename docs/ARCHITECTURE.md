# Architektura

idswyft składa się z 4 komponentów (model docker-compose w upstreamie):
- **api** — orchestrator REST (Express/TS), pipeline weryfikacji, auth, webhooki. Port 3001.
- **engine** — ML (PaddleOCR, face-api, liveness, tamper/deepfake). Ciężki (~1.5GB). Port 3002.
- **frontend** — hosted UI (Vite/React), strony weryfikacji + portal developera + panel admina. Port 8080 (nginx).
- **postgres** — baza (Postgres 16).

`api` woła `engine` przez `ENGINE_URL` (HTTP). Bez `ENGINE_URL` api ma lokalne fallbacki, ale na obu naszych środowiskach engine jest osobno.

---

## Preprod — Fly.io (region fra)

Każdy komponent = osobna aplikacja Fly, budowana z `fly.{api,engine,frontend}.toml` (Dockerfile z repo).

| App Fly | Rola | Config |
|---------|------|--------|
| `idswyft-api-preprod` | API (publiczne) | `fly.api.toml` → `backend/Dockerfile` |
| `idswyft-engine-preprod` | Engine ML | `fly.engine.toml` → `engine/Dockerfile` |
| `idswyft-web-preprod` | Frontend (nginx) | `fly.frontend.toml` → `Dockerfile.frontend` + `frontend/nginx.fly.conf` |
| `idswyft-db-preprod` | Fly Postgres | — |

**Frontend↔API:** `frontend/nginx.fly.conf` proxy'uje `/api/` → `https://idswyft-api-preprod.fly.dev` (same-origin, cookies first-party, CSP `connect-src` zawiera domenę API).

**Sekrety (Fly secrets na `idswyft-api-preprod`):**
`API_KEY_SECRET, DATABASE_URL, ENCRYPTION_KEY, ENGINE_URL, JWT_SECRET, SERVICE_TOKEN, CORS_ORIGINS, FRONTEND_URL, RESEND_API_KEY, EMAIL_FROM`.

**Specyfika:**
- `FRONTEND_URL=https://idswyft-web-preprod.fly.dev` — żeby `verification_url` z `initialize` wskazywał na web, nie na API.
- `CORS_ORIGINS` zawiera `https://pyk-web-preprod.fly.dev,https://pyk-api-preprod.fly.dev`.
- Maszyny mają `auto_stop_machines=stop` + `auto_start_machines=true` + `min_machines_running=0` → usypiają i budzą się na request (cold start kilka sekund; bywa przejściowy „insufficient memory" w fra — patrz OPERATIONS.md).

---

## Prod — GCP (projekt `idswyft-production`, europe-central2)

**Kształt (wybór: Cloud Run + Postgres w kontenerze na VM):**

```
            Global External HTTPS LB (IP 8.233.246.51, Google-managed cert)
             ├── kyc.fizen.com      → Cloud Run idswyft-web   (nginx static)
             └── kyc-api.fizen.com  → Cloud Run idswyft-api
idswyft-web nginx ── /api/ proxy (same-origin) ─▶ kyc-api.fizen.com
idswyft-api ── VPC connector (egress=all-traffic) ─▶ idswyft-engine (Cloud Run, ingress=internal)
            └────────────────────────────────────▶ Postgres VM 10.10.0.2:5432 (SSL, prywatnie)
idswyft-api ── wolumen GCS ─▶ gs://idswyft-prod-uploads (uploady, szyfrowane)
```

| Komponent | Zasób GCP |
|-----------|-----------|
| Web | Cloud Run `idswyft-web` (publiczne, min=1) — `Dockerfile.web.gcp` + `frontend/nginx.gcp.conf` |
| API | Cloud Run `idswyft-api` (publiczne, min=1, VPC connector `idswyft-conn`, egress=all-traffic) |
| Engine | Cloud Run `idswyft-engine` (**ingress=internal**, min=1 warm, 2 vCPU / 4 GB) |
| DB | GCE VM `idswyft-postgres` (e2-medium, Container-Optimized OS), Postgres 16 w Dockerze, **private IP 10.10.0.2**, SSL on (self-signed cert), dane na dysku `idswyft-pg-data` (50 GB pd-ssd, dzienne snapshoty) |
| Sieć | VPC `idswyft-vpc`, subnet `idswyft-subnet` 10.10.0.0/24, connector `idswyft-conn` 10.8.0.0/28, Cloud NAT `idswyft-nat` (egress dla prywatnej VM) |
| Storage | GCS `gs://idswyft-prod-uploads` zamontowany jako wolumen Cloud Run w `/app/backend/uploads`; `STORAGE_PROVIDER=local` + `STORAGE_ENCRYPTION=true` (AES-256-GCM) |
| Sekrety | Secret Manager: `idswyft-{jwt-secret,api-key-secret,encryption-key,service-token,database-url}` |
| Konto serwisowe | `idswyft-run@idswyft-production.iam` (secretAccessor + storage.objectAdmin) |
| Obrazy | Artifact Registry `europe-central2-docker.pkg.dev/idswyft-production/idswyft/{engine,api,web}` (build przez Cloud Build) |
| LB | static IP `8.233.246.51`, managed cert dla `kyc.fizen.com` + `kyc-api.fizen.com`, URL-map host-routing (default→web, `kyc-api`→api) |
| DNS | `kyc.fizen.com` + `kyc-api.fizen.com` → A `8.233.246.51` (Cloudflare, **DNS only / grey** — proxy off, bo managed cert wymaga bezpośredniego rozwiązania) |

**Kluczowe decyzje / pułapki (rozwiązane):**
- **Engine bez auth** → musi być `ingress=internal`; API dociera przez connector z `--vpc-egress=all-traffic`.
- **PgClient wymusza SSL dla nie-lokalnego hosta** → Postgres w kontenerze ma `ssl=on` (self-signed), API ma `DATABASE_SSL_REJECT_UNAUTHORIZED=false`.
- **Migracje nie są w obrazie** → `supabase/migrations/*.sql` aplikujemy ręcznie do prod DB (błędy RLS/storage są Supabase-specyficzne, ignorujemy). Patrz DEPLOYMENT.md.
- **`s3` provider w idswyft nie ma override endpointu** → nie nadaje się pod GCS; dlatego wolumen GCS + provider `local`.
- **domain-mappings Cloud Run nie są wspierane w europe-central2** → stąd Global HTTPS LB.
- **COS: zapisywalny mount to `/mnt/disks/...`** (root FS read-only).
- **Email tylko przez Resend** (brak SMTP w kodzie) — prod potrzebuje `RESEND_API_KEY` + `EMAIL_FROM`.

**Runbook GCP** (komendy provisioningu/redeployu): `deploy/gcp/README.md` w repo.

---

## Wspólne dla obu środowisk
- **Auth API**: `X-API-Key` (klucz `ik_` + 64 hex, hashowany HMAC-SHA256(klucz, API_KEY_SECRET)).
- **Auth portali** (developer/admin/reviewer): JWT w httpOnly cookie `idswyft_token`, logowanie przez OTP (email/Resend).
- **Role Postgres**: idswyft oczekuje ról `service_role/anon/authenticated` (Supabase-owe) — tworzymy je ręcznie na obu środowiskach.
- **Storage uploadów**: efemeryczny dysk Cloud Run/Fly → uploady muszą iść do trwałego storage (GCS na prodzie; Fly volume na preprodzie).
