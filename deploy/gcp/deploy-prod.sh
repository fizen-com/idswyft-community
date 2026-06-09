#!/bin/bash
# One-shot production deploy for idswyft on GCP (project idswyft-production).
# Builds all three images from the CURRENT working tree via Cloud Build (amd64),
# then redeploys the Cloud Run services. Run from the repo root.
#
#   ./deploy/gcp/deploy-prod.sh           # build + deploy all
#   ./deploy/gcp/deploy-prod.sh api       # only api (also: engine | web)
#
# Prereqs: gcloud authed, project resources already provisioned (see README.md).
# NOTE: if supabase/migrations changed, apply them to the prod DB separately
#       (see "Apply DB migrations" in deploy/gcp/README.md) — this script does
#       NOT run migrations.
set -euo pipefail

PROJECT=idswyft-production
REGION=europe-central2
AR=europe-central2-docker.pkg.dev/$PROJECT/idswyft
TARGET="${1:-all}"

build_and_deploy() {
  local svc="$1"        # engine | api | web
  echo "==> Building $svc"
  gcloud builds submit --project="$PROJECT" \
    --config="deploy/gcp/cloudbuild.${svc}.yaml" .
  echo "==> Deploying idswyft-$svc"
  gcloud run deploy "idswyft-$svc" --project="$PROJECT" --region="$REGION" \
    --image="$AR/${svc}:latest"
}

# Order matters: engine first (api depends on it at runtime via ENGINE_URL).
case "$TARGET" in
  all)    build_and_deploy engine; build_and_deploy api; build_and_deploy web ;;
  engine) build_and_deploy engine ;;
  api)    build_and_deploy api ;;
  web)    build_and_deploy web ;;
  *) echo "Unknown target: $TARGET (use: all | engine | api | web)"; exit 1 ;;
esac

echo "==> Done. https://kyc.fizen.com  /  https://kyc-api.fizen.com"
