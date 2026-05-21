#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/build"
ZIP_FILE="$BUILD_DIR/lambda-push-menu.zip"
ENV_FILE="$ROOT_DIR/.env"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

PROJECT_NAME="${PROJECT_NAME:-alexa-plus-dinner-list}"
AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_PROFILE="${AWS_PROFILE:-default}"
LAMBDA_FUNCTION_NAME="${LAMBDA_FUNCTION_NAME:-$PROJECT_NAME}"
TARGETS_KEY="${TARGETS_KEY:-dinner-menu/targets.json}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd aws
require_cmd node
require_cmd npm
require_cmd zip

AWS=(aws --profile "$AWS_PROFILE" --region "$AWS_REGION")
AWS_GLOBAL=(aws --profile "$AWS_PROFILE")

AWS_ACCOUNT_ID="$("${AWS_GLOBAL[@]}" sts get-caller-identity --query Account --output text)"
TARGETS_BUCKET="${TARGETS_BUCKET:-${S3_BUCKET_NAME:-$PROJECT_NAME-$AWS_ACCOUNT_ID-$AWS_REGION}}"

mkdir -p "$BUILD_DIR"

TARGETS_FILE="$BUILD_DIR/targets.json"
LAMBDA_ENV_FILE="$BUILD_DIR/lambda-env-live.json"

echo "Updating widget fallback datasource from local menu JSON..."
node "$ROOT_DIR/scripts/update-widget-fallback.js"

echo "Updating deployed Lambda menu bundle..."
rm -rf "$BUILD_DIR/lambda-push-menu"
mkdir -p "$BUILD_DIR/lambda-push-menu/data"
cp "$ROOT_DIR/lambda/index.js" "$ROOT_DIR/lambda/package.json" "$BUILD_DIR/lambda-push-menu/"
cp "$ROOT_DIR/data/dinner-menu-items.json" "$BUILD_DIR/lambda-push-menu/data/"
if [[ -f "$ROOT_DIR/lambda/package-lock.json" ]]; then
  cp "$ROOT_DIR/lambda/package-lock.json" "$BUILD_DIR/lambda-push-menu/"
  (cd "$BUILD_DIR/lambda-push-menu" && npm ci --omit=dev)
elif node -e "const p=require('$ROOT_DIR/lambda/package.json'); process.exit(Object.keys(p.dependencies||{}).length ? 0 : 1)"; then
  (cd "$BUILD_DIR/lambda-push-menu" && npm install --omit=dev)
fi
(cd "$BUILD_DIR/lambda-push-menu" && zip -qr "$ZIP_FILE" .)
"${AWS[@]}" lambda update-function-code \
  --function-name "$LAMBDA_FUNCTION_NAME" \
  --zip-file "fileb://$ZIP_FILE" >/dev/null
"${AWS[@]}" lambda wait function-updated --function-name "$LAMBDA_FUNCTION_NAME"

echo "Fetching known Alexa Data Store targets..."
if ! "${AWS[@]}" s3api get-object \
  --bucket "$TARGETS_BUCKET" \
  --key "$TARGETS_KEY" \
  "$TARGETS_FILE" >/dev/null 2>&1; then
  printf '[]\n' > "$TARGETS_FILE"
fi

echo "Fetching Data Store credentials from deployed Lambda environment..."
"${AWS[@]}" lambda get-function-configuration \
  --function-name "$LAMBDA_FUNCTION_NAME" \
  --query 'Environment' \
  --output json > "$LAMBDA_ENV_FILE"

echo "Pushing local menu JSON directly to Alexa Data Store..."
MENU_FILE="$ROOT_DIR/data/dinner-menu-items.json" \
  TARGETS_FILE="$TARGETS_FILE" \
  LAMBDA_ENV_FILE="$LAMBDA_ENV_FILE" \
  node "$ROOT_DIR/scripts/push-menu-to-datastore.js"
