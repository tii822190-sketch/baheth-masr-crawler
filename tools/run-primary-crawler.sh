#!/usr/bin/env bash
set -euo pipefail

processed_pages=0
batch_number=0
: > /tmp/primary-crawler-result.json

while [ "$processed_pages" -lt "${CRAWLER_MAX_PAGES:-1000}" ]; do
  batch_number=$((batch_number + 1))
  output=$(node crawler/src/cli.mjs manual)
  echo "===== batch ${batch_number} =====" | tee -a /tmp/primary-crawler-result.json
  echo "$output" | tee -a /tmp/primary-crawler-result.json
  processed=$(node -e "const x=JSON.parse(process.argv[1]); console.log(Number(x.total)||0)" "$output")
  processed_pages=$((processed_pages + processed))
  if [ "$processed" -eq 0 ]; then break; fi
done

echo "processed_pages=${processed_pages}" | tee -a /tmp/primary-crawler-result.json
