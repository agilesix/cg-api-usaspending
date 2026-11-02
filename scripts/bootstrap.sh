#!/usr/bin/env bash
#
# One-time Cloudflare setup, safe to re-run. Does everything the deployed API
# needs, in order:
#
#   1. Creates the R2 bucket the snapshots live in (skipped if it exists).
#   2. Deploys the Worker. That also creates the daily Cron trigger and the
#      custom domain in wrangler.jsonc.
#   3. Saves SGG_API_KEY and SYNC_SECRET as Worker secrets.
#   4. Runs the first refresh through POST /admin/sync, so the API serves
#      today's data instead of the snapshot bundled with the code.
#
# Run it locally after `pnpm exec wrangler login`, or from the "Bootstrap"
# GitHub Action, which supplies CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
#
# Needs SGG_API_KEY and SYNC_SECRET in the environment. Locally they are read
# from .env and .dev.vars when present.

set -euo pipefail

BUCKET="usaspending-awards-snapshots"
BASE_URL="${BASE_URL:-https://usaspending.api.cg.a6lab.ai}"

cd "$(dirname "$0")/.."

# Local runs: pick up the same files `pnpm refresh` and `wrangler dev` use.
for file in .env .dev.vars; do
  if [ -f "$file" ]; then
    set -a
    # shellcheck disable=SC1090
    . "./$file"
    set +a
  fi
done

: "${SGG_API_KEY:?SGG_API_KEY is not set. Add it to .env or the environment.}"
: "${SYNC_SECRET:?SYNC_SECRET is not set. Add it to .dev.vars or the environment.}"

wrangler() { pnpm exec wrangler "$@"; }

echo "==> R2 bucket: ${BUCKET}"
if wrangler r2 bucket info "${BUCKET}" > /dev/null 2>&1; then
  echo "    already exists"
else
  wrangler r2 bucket create "${BUCKET}"
fi

echo "==> Deploying the Worker"
wrangler deploy

echo "==> Saving Worker secrets"
printf '%s' "${SGG_API_KEY}" | wrangler secret put SGG_API_KEY
printf '%s' "${SYNC_SECRET}" | wrangler secret put SYNC_SECRET

echo "==> First refresh: POST ${BASE_URL}/admin/sync"
# A new custom domain can take a minute to answer, so retry for a few minutes.
for attempt in 1 2 3 4 5 6; do
  status=$(curl -sS -o /tmp/bootstrap-sync.json -w '%{http_code}' -X POST \
    -H "Authorization: Bearer ${SYNC_SECRET}" --max-time 300 \
    "${BASE_URL%/}/admin/sync" || true)
  if [ "${status}" = "200" ]; then
    cat /tmp/bootstrap-sync.json
    echo
    echo "==> Done. Try ${BASE_URL%/}/snapshot and ${BASE_URL%/}/docs"
    exit 0
  fi
  echo "    attempt ${attempt}: HTTP ${status}, retrying in 30s"
  sleep 30
done

echo "The Worker is deployed, but the first refresh did not answer 200." >&2
echo "Run the Manual sync action once the domain is live; the daily Cron will also run it." >&2
exit 1
