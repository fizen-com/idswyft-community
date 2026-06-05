# Deployment i sync

Model pracy: **iterujemy na preprodzie (Fly), potem jeden sync do proda (GCP).**

## Branch / CI
- Repo: `fizen-com/idswyft-community`, branch **`main`** = preprod (working branch).
- CI (`.github/workflows/ci.yml`) działa na push do main, ale **failuje** (npm audit / test) — nie blokuje nas, bo deployujemy ręcznie przez `flyctl`.
- `deploy-preprod.yml` jest gated na CI success → przy failującym CI auto-deploy się nie uruchamia. Dlatego deploy ręczny.

---

## Preprod (Fly.io) — deploy ręczny

Z roota repo, build zdalny (amd64, omija lokalnego Dockera):
```bash
# po zmianie w backend/ lub shared/:
flyctl deploy --config fly.api.toml --remote-only
# po zmianie w engine/ lub shared/:
flyctl deploy --config fly.engine.toml --remote-only
# po zmianie we frontend/:
flyctl deploy --config fly.frontend.toml --remote-only
```
> `shared/` wpływa i na api, i na engine. Liveness/OCR liczą się w **engine** → po zmianie progów liveness/OCR rebuilduj **engine**.

**Sekrety preprod** (nie w gicie):
```bash
fly secrets set KEY=VALUE -a idswyft-api-preprod   # restart maszyny
```
Ustawione: `FRONTEND_URL, CORS_ORIGINS, RESEND_API_KEY, EMAIL_FROM` (+ bazowe z install).

**Migracje na preprod DB** (gdy zmieni się `supabase/migrations/`): patrz sekcja „Migracje" niżej (analogicznie, przez Fly Postgres).

---

## Prod (GCP) — sync jedną komendą

Cały kod jest na `fizen/main`. Sync = build 3 obrazów z gita + redeploy Cloud Run:
```bash
./deploy/gcp/deploy-prod.sh            # all (engine→api→web)
./deploy/gcp/deploy-prod.sh api        # punktowo
```
Skrypt: Cloud Build (`deploy/gcp/cloudbuild.{engine,api,web}.yaml`) → `gcloud run deploy`. Runbook provisioningu: `deploy/gcp/README.md`.

### ⚠️ CHECKLISTA SYNCU PRODA — nie pominąć
1. **Kod**: `./deploy/gcp/deploy-prod.sh` (buduje z `fizen/main`). Wszystkie nasze zmiany są zacommitowane (d7e2b75 /media, 3082085 PL-UX+reliability).
2. **Migracje DB**: prod DB budowane przez ręczne aplikowanie `supabase/migrations/`. **Nowe migracje trzeba dołożyć** — szczególnie **`61_add_verification_completed_at.sql`**. **Prod DB nie ma jeszcze `completed_at`** → bez tego `/restart` na prodzie zwróci ciche 409. Aplikuj przed/razem z kodem.
3. **Sekrety**: prod potrzebuje `RESEND_API_KEY` + `EMAIL_FROM="Fizen <noreply@fizen.com>"` w Secret Manager / na serwisie api (domena fizen.com już verified w Resend → reuse). Reszta sekretów już jest.
4. **Role Postgres**: `service_role/anon/authenticated` już są na prod VM (startup script).
5. **Audyt po syncu**: powtórz audyt schematu (OPERATIONS.md) na prod DB dla pewności.

---

## Migracje

idswyft **nie aplikuje migracji w obrazie** (`No migrations directory found at /app/backend/migrations — skipping`). Stosujemy ręcznie.

### Preprod (Fly Postgres) / Prod (GCE VM) — wzorzec
```bash
# skopiuj migracje na maszynę z bazą, potem dla każdej:
for f in $(ls migrations/*.sql | sort); do
  psql -U idswyft -d idswyft -v ON_ERROR_STOP=0 < "$f"
done
```
- Każdy plik osobno, `ON_ERROR_STOP=0` → błędy RLS/storage/auth (Supabase-specyficzne) są logowane i pomijane — to OK.
- Role `service_role/anon/authenticated` muszą istnieć **przed** migracjami.
- Prod VM: `gcloud compute scp --recurse --tunnel-through-iap supabase/migrations idswyft-postgres:~/mig` → `docker exec -i pg psql ...` (pełna komenda w `deploy/gcp/README.md`).

### Po dodaniu nowej migracji
1. Plik `supabase/migrations/NN_nazwa.sql` (z `IF NOT EXISTS` — idempotentnie).
2. Commit + push do `fizen/main`.
3. Zaaplikuj do preprod DB i (przy syncu) do prod DB.

---

## Niezacommitowane (stan na teraz)
- `deploy/`, `Dockerfile.web.gcp`, `frontend/nginx.gcp.conf` — infra GCP (działa, do zacommitowania przed/przy formalnym prodzie).
- Śmieci (NIE commitować): `front.jpg`, `back.jpg`, `license.jpg` (testowe PII), `docker-initdb/`.
