#!/usr/bin/env bash
# One-time GCP bootstrap + deploy for the tab recorder backend.
# Usage: PROJECT_ID=my-project [REGION=us-central1] ./infra/setup.sh [bootstrap|deploy|all]
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID to your GCP project id}"
REGION="${REGION:-us-central1}"
BUCKET="${BUCKET:-${PROJECT_ID}-tab-recorder-audio}"
ACTION="${1:-all}"

API_SA="tab-rec-api"
WORKER_SA="tab-rec-worker"
INVOKER_SA="tab-rec-tasks-invoker"

gcloud config set project "$PROJECT_ID"

bootstrap() {
  echo "==> Enabling APIs"
  gcloud services enable \
    run.googleapis.com \
    cloudtasks.googleapis.com \
    firestore.googleapis.com \
    secretmanager.googleapis.com \
    storage.googleapis.com \
    drive.googleapis.com \
    docs.googleapis.com \
    gmail.googleapis.com \
    cloudbuild.googleapis.com \
    artifactregistry.googleapis.com \
    iam.googleapis.com

  echo "==> Firestore (Native mode)"
  gcloud firestore databases create --location="$REGION" --type=firestore-native \
    || echo "    (database already exists)"

  echo "==> GCS bucket for extracted audio (7-day lifecycle)"
  if ! gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1; then
    gcloud storage buckets create "gs://$BUCKET" --location="$REGION" \
      --uniform-bucket-level-access
    echo '{"rule":[{"action":{"type":"Delete"},"condition":{"age":7}}]}' > /tmp/lifecycle.json
    gcloud storage buckets update "gs://$BUCKET" --lifecycle-file=/tmp/lifecycle.json
  fi

  echo "==> Service accounts"
  for sa in "$API_SA" "$WORKER_SA" "$INVOKER_SA"; do
    gcloud iam service-accounts create "$sa" --display-name="$sa" \
      || echo "    ($sa already exists)"
  done

  echo "==> Cloud Tasks queues (one per stage)"
  for queue in extract transcribe-submit finalize; do
    gcloud tasks queues create "$queue" --location="$REGION" \
      --max-attempts=8 --min-backoff=10s --max-backoff=600s \
      || echo "    ($queue already exists)"
  done

  echo "==> Secrets (placeholders; set real values with 'gcloud secrets versions add')"
  for secret in assemblyai-api-key oauth-client-secret session-jwt-key webhook-secret token-fernet-key; do
    gcloud secrets create "$secret" --replication-policy=automatic \
      || echo "    ($secret already exists)"
  done

  echo "==> IAM bindings"
  for sa in "$API_SA" "$WORKER_SA"; do
    member="serviceAccount:${sa}@${PROJECT_ID}.iam.gserviceaccount.com"
    gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="$member" \
      --role=roles/datastore.user --condition=None >/dev/null
    gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="$member" \
      --role=roles/secretmanager.secretAccessor --condition=None >/dev/null
    gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="$member" \
      --role=roles/storage.objectAdmin >/dev/null
  done
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${API_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role=roles/cloudtasks.enqueuer --condition=None >/dev/null
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${WORKER_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role=roles/cloudtasks.enqueuer --condition=None >/dev/null
  # Worker SA signs V4 URLs for GCS objects handed to AssemblyAI
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${WORKER_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role=roles/iam.serviceAccountTokenCreator --condition=None >/dev/null
  # api + worker attach OIDC tokens for the invoker SA to Cloud Tasks, which
  # requires actAs on that SA
  for sa in "$API_SA" "$WORKER_SA"; do
    gcloud iam service-accounts add-iam-policy-binding \
      "${INVOKER_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
      --member="serviceAccount:${sa}@${PROJECT_ID}.iam.gserviceaccount.com" \
      --role=roles/iam.serviceAccountUser >/dev/null
  done
}

secrets() {
  echo "==> Loading secret values from backend/.env into Secret Manager"
  local env_file="backend/.env"
  [[ -f "$env_file" ]] || { echo "backend/.env not found"; exit 1; }
  # secret-name:ENV_VAR pairs (macOS bash 3.2 has no associative arrays)
  for pair in \
    assemblyai-api-key:ASSEMBLYAI_API_KEY \
    oauth-client-secret:GOOGLE_OAUTH_CLIENT_SECRET \
    session-jwt-key:SESSION_JWT_SECRET \
    webhook-secret:WEBHOOK_SECRET \
    token-fernet-key:TOKEN_FERNET_KEY; do
    local secret="${pair%%:*}" var="${pair##*:}" value
    value=$(grep "^${var}=" "$env_file" | cut -d= -f2-)
    if [[ -z "$value" ]]; then
      echo "    skipping $secret (no value in backend/.env)"
      continue
    fi
    printf '%s' "$value" | gcloud secrets versions add "$secret" --data-file=-
    echo "    $secret ✓"
  done
}

deploy() {
  CLIENT_ID="${GOOGLE_OAUTH_CLIENT_ID:-$(grep '^GOOGLE_OAUTH_CLIENT_ID=' backend/.env | cut -d= -f2-)}"
  [[ -n "$CLIENT_ID" ]] || { echo "GOOGLE_OAUTH_CLIENT_ID missing (backend/.env)"; exit 1; }
  INVOKER_EMAIL="${INVOKER_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
  COMMON_ENV="GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GCP_REGION=${REGION},GCS_BUCKET=${BUCKET},TASKS_LOCATION=${REGION},GOOGLE_OAUTH_CLIENT_ID=${CLIENT_ID},TASKS_INVOKER_SERVICE_ACCOUNT=${INVOKER_EMAIL}"

  echo "==> Deploying worker (private, Cloud Tasks OIDC only)"
  gcloud run deploy tab-rec-worker \
    --source backend \
    --region "$REGION" \
    --service-account "${WORKER_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
    --no-allow-unauthenticated \
    --timeout 1800 \
    --concurrency 1 \
    --cpu 2 --memory 2Gi \
    --command uvicorn --args app.worker.main:app,--host,0.0.0.0,--port,8080 \
    --set-env-vars "$COMMON_ENV" \
    --set-secrets "ASSEMBLYAI_API_KEY=assemblyai-api-key:latest,GOOGLE_OAUTH_CLIENT_SECRET=oauth-client-secret:latest,WEBHOOK_SECRET=webhook-secret:latest,TOKEN_FERNET_KEY=token-fernet-key:latest"

  gcloud run services add-iam-policy-binding tab-rec-worker --region "$REGION" \
    --member="serviceAccount:${INVOKER_EMAIL}" \
    --role=roles/run.invoker

  WORKER_URL=$(gcloud run services describe tab-rec-worker --region "$REGION" --format='value(status.url)')
  echo "    worker: $WORKER_URL"

  echo "==> Deploying api (public: extension + AssemblyAI webhook)"
  gcloud run deploy tab-rec-api \
    --source backend \
    --region "$REGION" \
    --service-account "${API_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
    --allow-unauthenticated \
    --timeout 300 \
    --cpu 1 --memory 512Mi \
    --command uvicorn --args app.api.main:app,--host,0.0.0.0,--port,8080 \
    --set-env-vars "${COMMON_ENV},WORKER_BASE_URL=${WORKER_URL}" \
    --set-secrets "ASSEMBLYAI_API_KEY=assemblyai-api-key:latest,GOOGLE_OAUTH_CLIENT_SECRET=oauth-client-secret:latest,SESSION_JWT_SECRET=session-jwt-key:latest,WEBHOOK_SECRET=webhook-secret:latest,TOKEN_FERNET_KEY=token-fernet-key:latest"

  API_URL=$(gcloud run services describe tab-rec-api --region "$REGION" --format='value(status.url)')
  echo "    api: $API_URL"

  echo "==> Pointing the worker at the api (webhooks) and itself (poll tasks)"
  gcloud run services update tab-rec-worker --region "$REGION" \
    --update-env-vars "API_BASE_URL=${API_URL},WORKER_BASE_URL=${WORKER_URL}"

  echo ""
  echo "Deployed. Now set the extension to use the backend:"
  echo "  extension/.env -> WXT_API_BASE_URL=${API_URL}"
  echo "  cd extension && npm run build, then reload the extension and sign in again."
}

case "$ACTION" in
  bootstrap) bootstrap ;;
  secrets) secrets ;;
  deploy) deploy ;;
  all) bootstrap && secrets && deploy ;;
  *) echo "Unknown action: $ACTION (use bootstrap|secrets|deploy|all)"; exit 1 ;;
esac
