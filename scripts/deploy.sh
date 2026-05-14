#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/build"
ZIP_FILE="$BUILD_DIR/lambda.zip"
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
LAMBDA_ROLE_NAME="${LAMBDA_ROLE_NAME:-$PROJECT_NAME-lambda-role}"
DEPLOY_SKILL="${DEPLOY_SKILL:-0}"
ASK_PROFILE="${ASK_PROFILE:-default}"
MENU_KEY="${MENU_KEY:-dinner-menu/items.json}"
TARGETS_KEY="${TARGETS_KEY:-dinner-menu/targets.json}"

AWS=(aws --profile "$AWS_PROFILE" --region "$AWS_REGION")
AWS_GLOBAL=(aws --profile "$AWS_PROFILE")

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

AWS_ACCOUNT_ID="$("${AWS_GLOBAL[@]}" sts get-caller-identity --query Account --output text)"
S3_BUCKET_NAME="${S3_BUCKET_NAME:-$PROJECT_NAME-$AWS_ACCOUNT_ID-$AWS_REGION}"

echo "Checking Lambda source..."
(cd "$ROOT_DIR/lambda" && npm test)

echo "Building Lambda zip..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/lambda"
cp "$ROOT_DIR/lambda/index.js" "$ROOT_DIR/lambda/package.json" "$BUILD_DIR/lambda/"
if [[ -f "$ROOT_DIR/lambda/package-lock.json" ]]; then
  cp "$ROOT_DIR/lambda/package-lock.json" "$BUILD_DIR/lambda/"
  (cd "$BUILD_DIR/lambda" && npm ci --omit=dev)
elif node -e "const p=require('$ROOT_DIR/lambda/package.json'); process.exit(Object.keys(p.dependencies||{}).length ? 0 : 1)"; then
  (cd "$BUILD_DIR/lambda" && npm install --omit=dev)
fi
(cd "$BUILD_DIR/lambda" && zip -qr "$ZIP_FILE" .)

echo "Ensuring Lambda execution role exists..."
ROLE_ARN="$("${AWS_GLOBAL[@]}" iam get-role --role-name "$LAMBDA_ROLE_NAME" --query 'Role.Arn' --output text 2>/dev/null || true)"
if [[ -z "$ROLE_ARN" || "$ROLE_ARN" == "None" ]]; then
  TRUST_POLICY="$BUILD_DIR/lambda-trust-policy.json"
  cat > "$TRUST_POLICY" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
JSON
  ROLE_ARN="$("${AWS_GLOBAL[@]}" iam create-role \
    --role-name "$LAMBDA_ROLE_NAME" \
    --assume-role-policy-document "file://$TRUST_POLICY" \
    --query 'Role.Arn' \
    --output text)"
  "${AWS_GLOBAL[@]}" iam attach-role-policy \
    --role-name "$LAMBDA_ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  echo "Waiting for IAM role propagation..."
  sleep 10
fi

echo "Ensuring S3 menu bucket exists..."
if ! "${AWS_GLOBAL[@]}" s3api head-bucket --bucket "$S3_BUCKET_NAME" >/dev/null 2>&1; then
  if [[ "$AWS_REGION" == "us-east-1" ]]; then
    "${AWS[@]}" s3api create-bucket --bucket "$S3_BUCKET_NAME" >/dev/null
  else
    "${AWS[@]}" s3api create-bucket \
      --bucket "$S3_BUCKET_NAME" \
      --create-bucket-configuration "LocationConstraint=$AWS_REGION" >/dev/null
  fi
fi

"${AWS[@]}" s3api put-public-access-block \
  --bucket "$S3_BUCKET_NAME" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

S3_POLICY_FILE="$BUILD_DIR/lambda-s3-policy.json"
cat > "$S3_POLICY_FILE" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::$S3_BUCKET_NAME",
      "Condition": {
        "StringLike": {
          "s3:prefix": [
            "$MENU_KEY",
            "$TARGETS_KEY"
          ]
        }
      }
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject"
      ],
      "Resource": [
        "arn:aws:s3:::$S3_BUCKET_NAME/$MENU_KEY",
        "arn:aws:s3:::$S3_BUCKET_NAME/$TARGETS_KEY"
      ]
    }
  ]
}
JSON

"${AWS_GLOBAL[@]}" iam put-role-policy \
  --role-name "$LAMBDA_ROLE_NAME" \
  --policy-name "$PROJECT_NAME-s3-menu-access" \
  --policy-document "file://$S3_POLICY_FILE"

echo "Deploying Lambda function $LAMBDA_FUNCTION_NAME in $AWS_REGION..."
FUNCTION_ARN="$("${AWS[@]}" lambda get-function \
  --function-name "$LAMBDA_FUNCTION_NAME" \
  --query 'Configuration.FunctionArn' \
  --output text 2>/dev/null || true)"

if [[ -z "$FUNCTION_ARN" || "$FUNCTION_ARN" == "None" ]]; then
  FUNCTION_ARN="$("${AWS[@]}" lambda create-function \
    --function-name "$LAMBDA_FUNCTION_NAME" \
    --runtime nodejs22.x \
    --role "$ROLE_ARN" \
    --handler index.handler \
    --zip-file "fileb://$ZIP_FILE" \
    --timeout 10 \
    --memory-size 256 \
    --architectures arm64 \
    --query 'FunctionArn' \
    --output text)"
else
  "${AWS[@]}" lambda update-function-code \
    --function-name "$LAMBDA_FUNCTION_NAME" \
    --zip-file "fileb://$ZIP_FILE" >/dev/null
  "${AWS[@]}" lambda wait function-updated --function-name "$LAMBDA_FUNCTION_NAME"
  "${AWS[@]}" lambda update-function-configuration \
    --function-name "$LAMBDA_FUNCTION_NAME" \
    --runtime nodejs22.x \
    --handler index.handler \
    --timeout 10 \
    --memory-size 256 >/dev/null
  "${AWS[@]}" lambda wait function-updated --function-name "$LAMBDA_FUNCTION_NAME"
fi

echo "Configuring Lambda S3 environment..."
CURRENT_ENV_JSON="$("${AWS[@]}" lambda get-function-configuration \
  --function-name "$LAMBDA_FUNCTION_NAME" \
  --query 'Environment.Variables' \
  --output json 2>/dev/null || echo '{}')"
ENV_JSON_FILE="$BUILD_DIR/lambda-env.json"
CURRENT_ENV_JSON="$CURRENT_ENV_JSON" \
  MENU_BUCKET="$S3_BUCKET_NAME" \
  MENU_KEY="$MENU_KEY" \
  TARGETS_KEY="$TARGETS_KEY" \
  node -e 'const current = JSON.parse(process.env.CURRENT_ENV_JSON || "{}") || {}; current.MENU_BUCKET = process.env.MENU_BUCKET; current.MENU_KEY = process.env.MENU_KEY; current.TARGETS_KEY = process.env.TARGETS_KEY; process.stdout.write(JSON.stringify({ Variables: current }));' > "$ENV_JSON_FILE"
"${AWS[@]}" lambda update-function-configuration \
  --function-name "$LAMBDA_FUNCTION_NAME" \
  --environment "file://$ENV_JSON_FILE" >/dev/null
"${AWS[@]}" lambda wait function-updated --function-name "$LAMBDA_FUNCTION_NAME"

echo "Ensuring initial menu JSON exists..."
if ! "${AWS[@]}" s3api head-object --bucket "$S3_BUCKET_NAME" --key "$MENU_KEY" >/dev/null 2>&1; then
  "${AWS[@]}" s3api put-object \
    --bucket "$S3_BUCKET_NAME" \
    --key "$MENU_KEY" \
    --body "$ROOT_DIR/data/dinner-menu-items.json" \
    --content-type application/json >/dev/null
fi

echo "Configuring S3 trigger for menu updates..."
BUCKET_ARN="arn:aws:s3:::$S3_BUCKET_NAME"
"${AWS[@]}" lambda add-permission \
  --function-name "$LAMBDA_FUNCTION_NAME" \
  --statement-id s3-menu-updates \
  --action lambda:InvokeFunction \
  --principal s3.amazonaws.com \
  --source-arn "$BUCKET_ARN" \
  --source-account "$AWS_ACCOUNT_ID" >/dev/null 2>&1 || true

NOTIFICATION_FILE="$BUILD_DIR/s3-notification.json"
cat > "$NOTIFICATION_FILE" <<JSON
{
  "LambdaFunctionConfigurations": [
    {
      "Id": "DinnerMenuJsonUpdates",
      "LambdaFunctionArn": "$FUNCTION_ARN",
      "Events": [
        "s3:ObjectCreated:*"
      ],
      "Filter": {
        "Key": {
          "FilterRules": [
            {
              "Name": "prefix",
              "Value": "$MENU_KEY"
            }
          ]
        }
      }
    }
  ]
}
JSON
"${AWS[@]}" s3api put-bucket-notification-configuration \
  --bucket "$S3_BUCKET_NAME" \
  --notification-configuration "file://$NOTIFICATION_FILE"

echo "Updating skill-package/skill.json endpoint URI..."
LAMBDA_ARN="$FUNCTION_ARN" node "$ROOT_DIR/scripts/set-skill-endpoint.js"

if [[ -n "${ALEXA_SKILL_ID:-}" ]]; then
  echo "Ensuring Alexa Skills Kit can invoke Lambda..."
  "${AWS[@]}" lambda add-permission \
    --function-name "$LAMBDA_FUNCTION_NAME" \
    --statement-id "ask-invoke-${ALEXA_SKILL_ID//[^A-Za-z0-9]/-}" \
    --action lambda:InvokeFunction \
    --principal alexa-appkit.amazon.com \
    --event-source-token "$ALEXA_SKILL_ID" >/dev/null 2>&1 || true
else
  echo "ALEXA_SKILL_ID is not set; adding broad Alexa invoke permission for first skill creation."
  "${AWS[@]}" lambda add-permission \
    --function-name "$LAMBDA_FUNCTION_NAME" \
    --statement-id ask-invoke-first-deploy \
    --action lambda:InvokeFunction \
    --principal alexa-appkit.amazon.com >/dev/null 2>&1 || true
fi

if [[ "$DEPLOY_SKILL" == "1" ]]; then
  require_cmd ask
  echo "Deploying skill package with ASK CLI..."
  (cd "$ROOT_DIR" && ask deploy --target skill-metadata --profile "$ASK_PROFILE")
else
  echo "Skipping ASK deploy because DEPLOY_SKILL is not 1."
fi

echo
echo "Deployment complete."
echo "Lambda ARN: $FUNCTION_ARN"
echo "Menu JSON: s3://$S3_BUCKET_NAME/$MENU_KEY"
echo "Skill endpoint file updated: $ROOT_DIR/skill-package/skill.json"
