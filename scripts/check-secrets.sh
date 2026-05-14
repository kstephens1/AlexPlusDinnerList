#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v rg >/dev/null 2>&1; then
  echo "Missing required command: rg" >&2
  exit 1
fi

cd "$ROOT_DIR"

if rg -n --hidden \
  --glob '!.git/**' \
  --glob '!node_modules/**' \
  --glob '!lambda/node_modules/**' \
  --glob '!build/**' \
  --glob '!package-lock.json' \
  '(BEGIN (RSA|OPENSSH|PRIVATE) KEY|amzn1\.ask\.skill\.[0-9a-f-]{36}|arn:aws:lambda:[a-z0-9-]+:[0-9]{12}:|s3://[a-z0-9][a-z0-9.-]*[a-z0-9]/|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|aws_secret_access_key[[:space:]]*=|aws_session_token[[:space:]]*=|ALEXA_SKILL_CLIENT_SECRET[[:space:]]*=.+)' \
  .; then
  echo "Potential secret or environment-specific deployed resource found." >&2
  exit 1
fi

echo "No high-confidence secrets found."
