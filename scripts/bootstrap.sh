#!/usr/bin/env bash
#
# One-time Cloudflare setup, safe to re-run. Does everything the deployed API
# needs, in order:
#
#   1. Creates the R2 bucket for raw upstream records (skipped if it exists),
#      with a lifecycle rule that expires old versions under history/ after a
#      year. The newest copy of each record, under records/, is kept.
#   2. Creates the D1 database (skipped if it exists) and writes its id into
#      wrangler.jsonc. Commit that change.
#   3. Applies the D1 migrations.
#   4. Deploys the Worker. That also creates the daily Cron trigger and the
#      sync Workflow.
#   5. Saves SGG_API_KEY and SYNC_SECRET as Worker secrets.
#   6. Starts the first refresh through POST /admin/sync. It runs in the
#      background for five to six hours; until it finishes, the API serves the
#      sample bundled with the code. Check /snapshot to see when it is done.
#
# With --infra-only it stops after step 3: it creates the bucket, lifecycle
# rule and database and applies the migrations, but deploys nothing. Use that
# before a PR that adds them is merged, so the branch never goes live
# unreviewed; CI deploys on merge, and the Manual sync action (or the daily
# Cron) starts the first refresh.
#
# Run it locally after `pnpm exec wrangler login`. It is not run from CI:
# creating the Worker, bucket and database needs more access than CI's
# per-Worker tokens have.
#
# It does not attach the custom domain, usaspending.api.cg.a6lab.ai: do that in
# the Cloudflare dashboard (Worker > Settings > Domains & Routes), as for the
# state APIs. On a first run, before the domain exists, set BASE_URL to the
# Worker's workers.dev URL so step 6 can reach it.
#
# Needs SGG_API_KEY and SYNC_SECRET in the environment (not for --infra-only).
# Locally they are read from .env and .dev.vars when present.

set -euo pipefail

INFRA_ONLY=false
# `pnpm run bootstrap -- --infra-only` passes the "--" through.
if [ "${1:-}" = "--" ]; then shift; fi
case "${1:-}" in
  "") ;;
  --infra-only) INFRA_ONLY=true ;;
  *) echo "Usage: $0 [--infra-only]" >&2; exit 2 ;;
esac

BUCKET="usaspending-awards-snapshots"
DATABASE="usaspending-awards-db"
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

if [ "${INFRA_ONLY}" = false ]; then
  : "${SGG_API_KEY:?SGG_API_KEY is not set. Add it to .env or the environment.}"
  : "${SYNC_SECRET:?SYNC_SECRET is not set. Add it to .dev.vars or the environment.}"
fi

wrangler() { pnpm exec wrangler "$@"; }

echo "==> R2 bucket: ${BUCKET}"
if wrangler r2 bucket info "${BUCKET}" > /dev/null 2>&1; then
  echo "    already exists"
else
  # wrangler.jsonc already binds the bucket as SNAPSHOTS. Without this flag a
  # local run asks to add a second binding, and answering yes rewrites the file.
  wrangler r2 bucket create "${BUCKET}" --update-config=false
fi

echo "==> R2 lifecycle: expire history/ after 365 days"
if wrangler r2 bucket lifecycle list "${BUCKET}" 2>/dev/null | grep -q "expire-history"; then
  echo "    already set"
else
  wrangler r2 bucket lifecycle add "${BUCKET}" expire-history history/ --expire-days 365 --force
fi

echo "==> D1 database: ${DATABASE}"
if ! wrangler d1 info "${DATABASE}" > /dev/null 2>&1; then
  wrangler d1 create "${DATABASE}" --update-config=false
fi
database_id=$(wrangler d1 list --json | node -e '
  let s = "";
  process.stdin.on("data", d => (s += d)).on("end", () => {
    const db = JSON.parse(s).find(d => d.name === process.argv[1]);
    if (!db) process.exit(1);
    console.log(db.uuid ?? db.database_id ?? db.id);
  });' "${DATABASE}")
if grep -q "REPLACE_WITH_DATABASE_ID" wrangler.jsonc; then
  sed -i.bak "s/REPLACE_WITH_DATABASE_ID/${database_id}/" wrangler.jsonc && rm wrangler.jsonc.bak
  echo "    wrote database_id ${database_id} to wrangler.jsonc: commit it"
fi

echo "==> D1 migrations"
wrangler d1 migrations apply "${DATABASE}" --remote

if [ "${INFRA_ONLY}" = true ]; then
  echo "==> Done (--infra-only). Commit wrangler.jsonc if it changed; nothing was deployed."
  exit 0
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
    -H "Authorization: Bearer ${SYNC_SECRET}" --max-time 60 \
    "${BASE_URL%/}/admin/sync" || true)
  if [ "${status}" = "202" ]; then
    cat /tmp/bootstrap-sync.json
    echo
    echo "==> Done. The first refresh is running; ${BASE_URL%/}/snapshot shows it once it finishes."
    exit 0
  fi
  echo "    attempt ${attempt}: HTTP ${status}, retrying in 30s"
  sleep 30
done

echo "The Worker is deployed, but the first refresh did not start." >&2
echo "Run the Manual sync action once the domain is live; the daily Cron will also start it." >&2
exit 1
