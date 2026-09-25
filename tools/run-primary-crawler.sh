#!/usr/bin/env bash
set -euo pipefail

processed_pages=0
batch_number=0
: > /tmp/primary-crawler-result.json
: > /tmp/primary-crawler-result.jsonl
export CRAWLER_PROGRESS_LOG_PATH=/tmp/primary-crawler-result.jsonl

while [ "$processed_pages" -lt "${CRAWLER_MAX_PAGES:-1000}" ]; do
  batch_number=$((batch_number + 1))
  echo "Starting crawler batch ${batch_number} (processed=${processed_pages})."
  output=$(node crawler/src/cli.mjs manual)
  echo "===== batch ${batch_number} =====" | tee -a /tmp/primary-crawler-result.json
  echo "$output" | tee -a /tmp/primary-crawler-result.json
  processed=$(node -e "const x=JSON.parse(process.argv[1]); console.log(Number(x.total)||0)" "$output")
  stopped_early=$(node -e "const x=JSON.parse(process.argv[1]); console.log(x.stopped_early ? 'true' : 'false')" "$output")
  processed_pages=$((processed_pages + processed))
  if [ "$processed" -eq 0 ] || [ "$stopped_early" = 'true' ]; then break; fi
done

echo "processed_pages=${processed_pages}" | tee -a /tmp/primary-crawler-result.json
