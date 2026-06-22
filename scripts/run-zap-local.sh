#!/usr/bin/env bash
# Ad-hoc OWASP ZAP baseline against a chosen target.
# Usage: ./scripts/run-zap-local.sh [URL]
# Default target: https://fibuki.com
# Output: build/zap/zap-baseline-YYYYMMDD-HHMMSS.{html,json}

set -euo pipefail

TARGET="${1:-https://fibuki.com}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="build/zap"
RULES_FILE="$(pwd)/.zap/rules.tsv"

mkdir -p "${OUT_DIR}"

echo "[zap] scanning ${TARGET}"
echo "[zap] reports → ${OUT_DIR}/zap-baseline-${TIMESTAMP}.*"

docker run --rm \
  -v "$(pwd)/${OUT_DIR}:/zap/wrk" \
  -v "${RULES_FILE}:/zap/wrk/rules.tsv:ro" \
  -t zaproxy/zap-stable \
  zap-baseline.py \
    -t "${TARGET}" \
    -c "rules.tsv" \
    -r "zap-baseline-${TIMESTAMP}.html" \
    -J "zap-baseline-${TIMESTAMP}.json" \
    -I

echo "[zap] done — open ${OUT_DIR}/zap-baseline-${TIMESTAMP}.html"
echo "[zap] paste the finding summary into docs/casa/08-dast-remediation-report.md §4"
