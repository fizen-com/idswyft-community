# idswyft — Production on GCP (project `idswyft-production`)

Prod deployment next to PYK/Fizen. Region **europe-central2**. Verified 2026-06-03.

## Architecture

```
                         Global External HTTPS LB (IP 8.233.246.51, managed cert)
                          ├── kyc.fizen.com      → idswyft-web  (Cloud Run, nginx static)
                          └── kyc-api.fizen.com  → idswyft-api  (Cloud Run)
idswyft-web nginx ──/api/ proxy (same-origin)──▶ kyc-api.fizen.com
idswyft-api ──VPC connector (all-traffic)──▶ idswyft-engine (Cloud Run, ingress=internal)
            └────────────────────────────────▶ Postgres VM 10.10.0.2:5432 (SSL, private)
idswyft-api ──GCS volume mount──▶ gs://idswyft-prod-uploads (STORAGE_PROVIDER=local + STORAGE_ENCRYPTION)
```

| Component | Resource |
|---|---|
| Web | Cloud Run `idswyft-web` (public, min=1) — built from `Dockerfile.web.gcp` + `frontend/nginx.gcp.conf` |
| API | Cloud Run `idswyft-api` (public, min=1, VPC connector all-traffic) — `backend/Dockerfile` |
| Engine | Cloud Run `idswyft-engine` (**ingress=internal**, min=1 warm, 2vCPU/4GB) — `engine/Dockerfile` |
| DB | GCE VM `idswyft-postgres` (e2-medium, COS), Postgres 16 in Docker, disk `idswyft-pg-data` (50GB pd-ssd, daily snapshots), private IP 10.10.0.2, SSL on (self-signed) |
| Network | VPC `idswyft-vpc`, subnet `idswyft-subnet` 10.10.0.0/24, connector `idswyft-conn` 10.8.0.0/28, Cloud NAT `idswyft-nat` |
| Storage | GCS `gs://idswyft-prod-uploads` (S3 not usable — provider has no endpoint override; mounted as Cloud Run volume instead) |
| Secrets | Secret Manager: `idswyft-{jwt-secret,api-key-secret,encryption-key,service-token,database-url}` |
| Images | Artifact Registry `europe-central2-docker.pkg.dev/idswyft-production/idswyft/{engine,api,web}` |
| Runtime SA | `idswyft-run@idswyft-production.iam.gserviceaccount.com` |

## Key decisions / gotchas
- **Engine has no auth** → must be `ingress=internal`; API reaches it via connector with `--vpc-egress=all-traffic`.
- **PgClient auto-enables SSL for non-local hosts** → Postgres container runs with `ssl=on` (self-signed); API set `DATABASE_SSL_REJECT_UNAUTHORIZED=false`.
- **Migrations are not in the image** (`No migrations directory found`) → apply `supabase/migrations/*.sql` manually to the DB (RLS/storage-bucket errors are Supabase-specific, ignore).
- **Same-origin web→api**: nginx proxies `/api/` to kyc-api.fizen.com (cookies first-party, CSP `connect-src 'self'`). `nginx.gcp.conf` uses a resolver+variable so nginx boots before the domain exists.
- **domain-mappings unsupported in europe-central2** → use the Global HTTPS LB above.
- COS stateful mount path is `/mnt/disks/...` (root FS is read-only).

## Build & redeploy

```bash
P=idswyft-production; R=europe-central2
AR=europe-central2-docker.pkg.dev/$P/idswyft
# build (Cloud Build, amd64) — run from repo root
gcloud builds submit --project=$P --config=deploy/gcp/cloudbuild.engine.yaml .
gcloud builds submit --project=$P --config=deploy/gcp/cloudbuild.api.yaml .
gcloud builds submit --project=$P --config=deploy/gcp/cloudbuild.web.yaml .
# redeploy
gcloud run deploy idswyft-engine --project=$P --region=$R --image=$AR/engine:latest
gcloud run deploy idswyft-api    --project=$P --region=$R --image=$AR/api:latest
gcloud run deploy idswyft-web    --project=$P --region=$R --image=$AR/web:latest
```

## DNS (add in fizen.com zone)
```
kyc.fizen.com.      A   8.233.246.51
kyc-api.fizen.com.  A   8.233.246.51
```
Managed cert auto-provisions once both records resolve (~15–60 min).

## Apply DB migrations (one-off / after schema changes)
```bash
gcloud compute scp --recurse --tunnel-through-iap --zone=europe-central2-a \
  supabase/migrations idswyft-postgres:~/mig
gcloud compute ssh idswyft-postgres --tunnel-through-iap --zone=europe-central2-a --command='
  for f in $(ls ~/mig/*.sql | sort); do sudo docker exec -i pg psql -U idswyft -d idswyft -v ON_ERROR_STOP=0 < "$f"; done'
```
Postgres roles `service_role/anon/authenticated` must exist (created once; see pg-startup notes).
