#!/usr/bin/env bash
# deploy-broker.sh — 部署 sandbox VM broker 到 Cloud Run，并完成权限隔离
#
# 权限模型：
# - broker 使用专用服务账号 cgm-sandbox-broker@，拥有创建 / 删除 VM 的权限（roles/compute.instanceAdmin.v1，
#   带 IAM Condition：只能操作名称为 cgm-sbx-* 的实例与磁盘）；
#   broker 自身只按白名单（C4 机型、已建子网的 region、固定镜像 / tag / 无 SA / 无外网 IP / Spot）创建 VM。
# - daemon VM 的服务账号只获得该 Cloud Run 服务的 roles/run.invoker，没有任何 compute 权限。
# - 服务不允许匿名访问（--no-allow-unauthenticated）。
#
# 用法：
#   REGION=us-central1 DAEMON_SA=daemon@PROJECT.iam.gserviceaccount.com \
#   SANDBOX_REGIONS="northamerica-northeast1 europe-west9" \
#   scripts/sandbox-vm/deploy-broker.sh [<project>]
#
# 可选：MACHINE_TYPES=c4-standard-2,c4-standard-4,c4-standard-8  IMAGE_FAMILY=cgm-sandbox-ephemeral
#       MAX_INSTANCES=32  MAX_RUN_SECONDS=86400  GC_MAX_AGE_SECONDS=90000
#       GC_SCHEDULE="17 * * * *"（Cloud Scheduler 定期 gc；空则不建）
set -euo pipefail

PROJECT="${1:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:?REGION (Cloud Run region) is required}"
DAEMON_SA="${DAEMON_SA:?DAEMON_SA (daemon VM service account email) is required}"
SANDBOX_REGIONS="${SANDBOX_REGIONS:?SANDBOX_REGIONS is required}"
SERVICE="${SERVICE:-cgm-sandbox-broker}"
BROKER_SA_NAME="${BROKER_SA_NAME:-cgm-sandbox-broker}"
BROKER_SA="${BROKER_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
MACHINE_TYPES="${MACHINE_TYPES:-c4-standard-2,c4-standard-4,c4-standard-8}"
IMAGE_FAMILY="${IMAGE_FAMILY:-cgm-sandbox-ephemeral}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

g() { gcloud --project "$PROJECT" "$@"; }

g services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com >/dev/null

# 构建用的专用服务账号（不依赖权限宽泛的 Compute 默认服务账号）
BUILDER_SA_NAME="${BUILDER_SA_NAME:-cgm-broker-builder}"
BUILDER_SA="${BUILDER_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
g iam service-accounts describe "$BUILDER_SA" >/dev/null 2>&1 || \
  g iam service-accounts create "$BUILDER_SA_NAME" --display-name "CyberGroupmate broker image builder"
g projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$BUILDER_SA" \
  --role roles/cloudbuild.builds.builder --condition=None >/dev/null

g iam service-accounts describe "$BROKER_SA" >/dev/null 2>&1 || \
  g iam service-accounts create "$BROKER_SA_NAME" --display-name "CyberGroupmate sandbox VM broker"
# IAM Condition：instanceAdmin 只作用于 cgm-sbx-* 的实例与磁盘（共享项目中不能修改 / 删除其他 VM）
BROKER_CONDITION='(resource.type != "compute.googleapis.com/Instance" || resource.name.extract("/instances/{name}").startsWith("cgm-sbx-")) && (resource.type != "compute.googleapis.com/Disk" || resource.name.extract("/disks/{name}").startsWith("cgm-sbx-"))'
g projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$BROKER_SA" \
  --role roles/compute.instanceAdmin.v1 \
  --condition="expression=${BROKER_CONDITION},title=cgm-sandbox-vms-only,description=Only cgm-sbx-* instances and disks" >/dev/null

subnets="{"
first=1
for r in $SANDBOX_REGIONS; do
  [ $first = 1 ] || subnets+=","
  subnets+="\"$r\":\"cgm-sandbox-$r\""
  first=0
done
subnets+="}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/src/core" "$tmp/src/sandbox"
cp "$REPO_ROOT/Dockerfile.broker" "$tmp/Dockerfile"
cp "$REPO_ROOT/src/core/logger.ts" "$tmp/src/core/"
cp -r "$REPO_ROOT/src/sandbox/provisioner" "$tmp/src/sandbox/"
cat > "$tmp/env.yaml" <<EOF
BROKER_SUBNETS: '$subnets'
BROKER_MACHINE_TYPES: '$MACHINE_TYPES'
BROKER_IMAGE_FAMILY: '$IMAGE_FAMILY'
BROKER_MAX_INSTANCES: '${MAX_INSTANCES:-32}'
BROKER_MAX_RUN_SECONDS: '${MAX_RUN_SECONDS:-86400}'
BROKER_GC_MAX_AGE_SECONDS: '${GC_MAX_AGE_SECONDS:-90000}'
GOOGLE_CLOUD_PROJECT: '$PROJECT'
EOF

g run deploy "$SERVICE" --region "$REGION" --source "$tmp" \
  --service-account "$BROKER_SA" \
  --build-service-account "projects/$PROJECT/serviceAccounts/$BUILDER_SA" \
  --no-allow-unauthenticated \
  --env-vars-file "$tmp/env.yaml" \
  --cpu 1 --memory 512Mi --concurrency 20 --min-instances 0 --max-instances 3 --timeout 600 \
  --quiet

g run services add-iam-policy-binding "$SERVICE" --region "$REGION" \
  --member "serviceAccount:$DAEMON_SA" --role roles/run.invoker >/dev/null

URL="$(g run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')"

if [ -n "${GC_SCHEDULE:-}" ]; then
  g services enable cloudscheduler.googleapis.com >/dev/null
  g run services add-iam-policy-binding "$SERVICE" --region "$REGION" \
    --member "serviceAccount:$BROKER_SA" --role roles/run.invoker >/dev/null
  g scheduler jobs describe "$SERVICE-gc" --location "$REGION" >/dev/null 2>&1 || \
    g scheduler jobs create http "$SERVICE-gc" --location "$REGION" --schedule "$GC_SCHEDULE" \
      --uri "$URL/v1/gc" --http-method POST --oidc-service-account-email "$BROKER_SA" --oidc-token-audience "$URL"
fi

echo "broker: $URL"
echo "config.yaml → sandbox.remote.provisioner.broker_url: $URL"
