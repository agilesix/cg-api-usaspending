# CommonGrants USAspending awards API

A [CommonGrants](https://commongrants.org) API for federal assistance awards. It
pulls awards from [USAspending](https://www.usaspending.gov), links each one to
the [Simpler.Grants.gov](https://simpler.grants.gov) opportunity it resulted
from, and serves both through the CommonGrants award and opportunity routes
(Core v0.5).

It is a reference implementation for the awards work: built from the
[CommonGrants Hono template](https://github.com/common-grants/cg-api-template-hono),
with every request and response validated against the published
[`@common-grants/sdk`](https://www.npmjs.com/package/@common-grants/sdk)
schemas, and deployed the same way as the state APIs
([cg-api-ca](https://github.com/agilesix/cg-api-ca) and its siblings).

It replaces [cg-usaspending](https://github.com/agilesix/cg-usaspending), the
script that first joined the two datasets.

---

## How the link works

USAspending reports a funding opportunity number on each assistance award
(`funding_opportunity.number`). Simpler.Grants.gov reports the same number on
each opportunity (`customFields.federalOpportunityNumber`, via the
[Grants.gov plugin](https://www.npmjs.com/package/@common-grants/cg-grants-gov)).
Matching the two gives the link, and it is published in both directions:

- **Opportunity to awards:** `GET /common-grants/opportunities/{oppId}` lists
  the awards it resulted in under `awards`.
- **Award to opportunity:** every award carries `opportunity`, with the
  opportunity number in `opportunity.identifiers["opp:us:fon"]`. Search awards
  with the `opportunityId` filter to get the full records for one opportunity.

## What it covers, and how fresh it is

**Every opportunity posted on Simpler.Grants.gov since October 1, 2024 (FY25),
in any status, and every USAspending grant award that came from one of them,
whenever it was made.** Opportunities with no awards yet are included; their
`awards` list fills in as awards are reported. About 5,300 opportunities and
23,000 awards as of November 2026.

A refresh runs once a day (08:00 UTC) as a Cloudflare Workflow:

1. **Opportunities.** Lists every opportunity in scope from Simpler.Grants.gov,
   then fetches the CommonGrants record of each one that is new or changed.
2. **Finding the awards.** USAspending cannot search by opportunity number, so
   the refresh requests a bulk download of every grant award (types 02-05)
   with activity since the start date, three columns wide, one fiscal year per
   file. Each file stays under USAspending's 500,000-row cap; a file that
   reaches it fails the refresh rather than silently dropping awards. Each file
   is streamed and only rows whose opportunity number matches are kept.
3. **Matching.** Opportunity numbers are compared case-, space- and
   dash-insensitively. A number reported without its prefix (`JG-26-0142` for
   `CDC-RFA-JG-26-0142`) matches when exactly one stored number ends that way;
   ambiguous numbers are counted, never guessed.
4. **Award records.** Fetches the full USAspending record of each award that is
   new, changed, or linked to an opportunity that changed, turns it into a
   CommonGrants `AwardBase`, and checks it against the SDK schema.
5. **Cleanup.** Removes opportunities and awards no longer found upstream, and
   awards whose opportunity is no longer served. Each kind has its own safety
   check, since a short listing usually means an upstream problem, not real
   deletions: opportunities are only removed when the run listed at least 90%
   of those served, and awards only when it found at least half of those
   stored.

Award status (`awarded` or `completed`) is worked out from the period of
performance each time a record is read, so it never goes stale between
refreshes. `GET /snapshot` reports when the last refresh finished and what it
counted at each step.

If a refresh fails, the API keeps serving the last good data, and the next
day's refresh (or the Manual sync action) tries again. A USAspending download that
fails to build is requested again, up to three times; after that, or when a
download comes back short or reaches the row cap, the refresh stops rather
than saving partial data.

Running locally with `pnpm run dev`, the API serves a small sample bundled at
`src/data/snapshot.json` instead, so no API key, network or database is needed.

## Get started

You need **Node.js 24** and **[pnpm](https://pnpm.io) 11.20.0**.

```bash
git clone https://github.com/agilesix/cg-api-usaspending.git
cd cg-api-usaspending
pnpm install --frozen-lockfile
pnpm run ci     # checks, build and tests
pnpm run dev    # http://localhost:3000/docs
```

A few requests to try:

```bash
# When the data was pulled, and what it covers
curl http://localhost:3000/snapshot

# A page of awards, most recently modified first
curl 'http://localhost:3000/common-grants/awards?pageSize=2'

# An opportunity, with the awards it resulted in
curl http://localhost:3000/common-grants/opportunities/<oppId>

# Every award from one opportunity, largest first
curl -X POST http://localhost:3000/common-grants/awards/search \
  -H 'Content-Type: application/json' \
  -d '{"filters":{"opportunityId":{"operator":"in","value":["<oppId>"]}},
       "sorting":{"sortBy":"funding.awardedAmount","sortOrder":"desc"}}'
```

### Refresh the bundled sample

Copy `.env.example` to `.env` and add a
[Simpler.Grants.gov API key](https://simpler.grants.gov/developer), then:

```bash
pnpm refresh
```

That rewrites the small sample in `src/data/snapshot.json` from the live APIs.
It is what `pnpm run dev`, the tests, and a fresh deployment (until its first
refresh finishes) serve. Commit it when you want the sample to move forward.
Settings such as the agencies and date window are read from the environment;
see [`src/pipeline/config.ts`](src/pipeline/config.ts).

### Run the full refresh locally

Put `SGG_API_KEY` and `SYNC_SECRET` in `.dev.vars`, then `pnpm run dev:worker`
(it applies the migrations to a local D1 database first). Start a refresh with
`curl -X POST -H "Authorization: Bearer $SYNC_SECRET" http://localhost:8787/admin/sync`.
The first load takes five to six hours, because USAspending rate-limits award
requests. Don't edit the code while it runs: `wrangler dev` reloads on change
and drops the run.

## Endpoints

| Method | Path                                   | Description                                                     |
| ------ | -------------------------------------- | --------------------------------------------------------------- |
| `GET`  | `/common-grants/awards`                | Paginated list, most recent `lastModifiedAt` first              |
| `GET`  | `/common-grants/awards/{awdId}`        | One award, with the opportunity it resulted from                |
| `POST` | `/common-grants/awards/search`         | Text search, filters, sorting, pagination                       |
| `GET`  | `/common-grants/opportunities`         | Paginated list of every opportunity in scope                    |
| `GET`  | `/common-grants/opportunities/{oppId}` | One opportunity, with the awards it resulted in                 |
| `POST` | `/common-grants/opportunities/search`  | Filtered, sorted, paginated search                              |
| `GET`  | `/snapshot`                            | When the data was pulled, what it covers, and the record counts |
| `GET`  | `/health`                              | Liveness check                                                  |
| `GET`  | `/openapi.json`                        | The OpenAPI 3.1 document                                        |
| `GET`  | `/docs`                                | Swagger UI                                                      |
| `GET`  | `/`                                    | Redirects to `/docs`                                            |
| `POST` | `/admin/sync`                          | Deployed only: start a refresh now (Bearer `SYNC_SECRET`), 202  |

Award search supports the protocol's default filters (`status`,
`opportunityId`, `awardDateRange`, `awardedAmountRange`) and sort keys. As in
the template, every success response is parsed with its SDK schema before it is
sent, so data that drifts from the published shape becomes a `500`, never a
`200`. Custom filters and sort keys are reported as not applied rather than
silently ignored.

Text search (`search` on awards) ignores case for ASCII letters only, as
SQLite's `lower()` and `LIKE` do: `ecole` finds `ECOLE`, but `école` does not
find `ÉCOLE`. Amount ranges compare to the cent.

## Deployment

Same setup as the state APIs: a Cloudflare Worker serving from a D1 database,
a daily Cron trigger, and an R2 bucket for raw upstream records. The refresh
runs as a Cloudflare Workflow, because it outlasts one Worker invocation (each
USAspending download takes several minutes to build).

| Piece                                                      | What it does                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [`wrangler.jsonc`](wrangler.jsonc)                         | Worker, D1, R2, the sync Workflow, daily Cron at 08:00 UTC, preview URLs         |
| [`migrations/`](migrations)                                | The D1 schema                                                                    |
| [`src/worker.ts`](src/worker.ts)                           | Serves from D1, starts the daily refresh and `/admin/sync`                       |
| [`src/sync/workflow.ts`](src/sync/workflow.ts)             | The refresh, step by step                                                        |
| [`scripts/bootstrap.sh`](scripts/bootstrap.sh)             | One-time setup: bucket, lifecycle rule, database, deploy, secrets, first refresh |
| [`cd-production.yml`](.github/workflows/cd-production.yml) | Checks and deploys on every push to `main`                                       |
| [`cd-preview.yml`](.github/workflows/cd-preview.yml)       | Uploads each PR as a preview version of the Worker                               |
| [`manual-sync.yml`](.github/workflows/manual-sync.yml)     | Starts a refresh on the deployed API from the Actions tab                        |

**Raw records.** Each raw upstream record is written to R2 only when it is new
or changed. The newest copy of every record is kept under `records/`; every
version is also written under `history/`, which a lifecycle rule expires after
365 days.

**Until the first refresh finishes,** a new deployment serves the bundled
sample, so it never serves an empty API.

**One-time setup.** `scripts/bootstrap.sh` does all of it except the custom
domain, and is safe to re-run. It creates the R2 bucket and its lifecycle rule,
creates the D1 database and writes its id into `wrangler.jsonc` (commit that),
applies the migrations, deploys the Worker (which also creates the Cron and the
Workflow), saves `SGG_API_KEY` and `SYNC_SECRET` as Worker secrets, and starts
the first refresh. Run it locally: `pnpm exec wrangler login`, put
`SGG_API_KEY` and `SYNC_SECRET` in `.dev.vars`, then `pnpm run bootstrap`.
Works from any branch. It stays out of CI because creating the Worker, bucket
and database needs more access than the per-Worker tokens below have.

To set up the bucket, lifecycle rule and database without deploying anything,
for example before merging the PR that adds them, run
`pnpm run bootstrap -- --infra-only`, commit the `database_id` it writes, and
let CI deploy on merge. Then start the first refresh with the Manual sync
action (or wait for the 08:00 UTC Cron). If CI's token cannot create the Workflow on that first deploy, run
`pnpm run bootstrap` (without the flag) from `main` instead. The account needs
the Workers Paid plan (for Workflows and the raised CPU limit).

Then attach `usaspending.api.cg.a6lab.ai` in the Cloudflare dashboard (Worker →
Settings → Domains & Routes). On a first run, before the domain exists, set
`BASE_URL` to the Worker's `workers.dev` URL so the bootstrap's first refresh
can reach it.

CI/CD shares one account-owned API token, limited to this Worker with the
**Individual Workers: Editor** role (per-Worker roles need account-owned
tokens). That is enough to upload previews and to deploy an existing Worker;
whether it can create the sync Workflow on the first deploy is unverified (see
the bootstrap fallback above). CD does not run D1 migrations: the bootstrap
applies them, so a later schema change needs
`wrangler d1 migrations apply usaspending-awards-db --remote` (by hand, or as a
CD step if the token is given D1 access). The custom domain is
kept out of `wrangler.jsonc`, as in the state APIs, because wrangler re-applies
listed custom domains on every deploy, and that needs access to the `a6lab.ai`
zone.

| Secret                  | What it is                                                          |
| ----------------------- | ------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Individual Workers Editor on `usaspending-commongrants-api`         |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account the state APIs use                           |
| `SYNC_SECRET`           | Any string; callers of `/admin/sync` must send it as a Bearer token |

Set the repository variable `PRODUCTION_BASE_URL` too; Manual sync needs it.
After setup, the Worker secrets persist across deploys, so
`cd-production.yml` only deploys. Re-run the bootstrap to change one.

**PR previews.** `cd-preview.yml` uploads every pull request from this
repository as a new version of the production Worker without deploying it, and
comments its URL on the PR: `https://pr-<number>-usaspending-commongrants-api.<subdomain>.workers.dev`.
Production traffic keeps going to the deployed version, and there is nothing to
clean up when the PR closes. A preview shares production's database, bucket and
secrets: it serves the same data, and because it runs with
`ENVIRONMENT=preview` it never starts a refresh (`/admin/sync` answers `403`
and the Cron does nothing). Preview URLs are public. Three caveats:

- Previews only get a URL once a production deploy has applied
  `preview_urls: true` from `wrangler.jsonc`.
- A preview reads production's D1 database, so a PR that changes the schema
  previews new code against the old schema. Keep migrations additive.
- While a preview is the Worker's newest version, `wrangler secret put` refuses
  to run until the next production deploy. Use `wrangler versions secret put`
  or re-run the bootstrap, which deploys before it sets secrets.

## If a refresh fails

- **See what happened.** The Workflows page in the Cloudflare dashboard (`usaspending-awards-sync`)
  shows each run's steps, retries and errors. In D1:
  `SELECT id, status, started_at, error FROM sync_runs ORDER BY started_at DESC LIMIT 5`.
- **Rerun.** Run the Manual sync action, or wait for the next daily Cron. A
  rerun only fetches what is still missing or changed. A refresh started while
  another is running stops at its first step.
- **A run stuck as `running`.** Runs block each other for up to 12 hours. If
  one died without being marked failed (for example, it was terminated from
  the dashboard), clear it in D1:
  `UPDATE sync_runs SET status = 'failed', error = 'cleared by hand' WHERE id = '<id>'`.

## Commands

| Command               | What it does                                          |
| --------------------- | ----------------------------------------------------- |
| `pnpm run dev`        | Start the Node server with reload on change           |
| `pnpm run dev:worker` | Run the Worker locally (local D1) with `wrangler dev` |
| `pnpm refresh`        | Rewrite the bundled sample from the live APIs         |
| `pnpm run test`       | Run the test suite                                    |
| `pnpm run checks`     | Lint, format check and typecheck                      |
| `pnpm run ci`         | `checks`, `build`, `test:coverage`                    |
| `pnpm run audit`      | The required dependency audit                         |
| `pnpm run deploy`     | Deploy the Worker (CI does this on push to `main`)    |
| `pnpm run bootstrap`  | One-time Cloudflare setup (see Deployment)            |

## Structure

```
src/
  index.ts             Node entrypoint: serves the bundled sample
  worker.ts            Cloudflare entrypoint: D1, Cron, /admin/sync
  app.ts               createApp(): runtime-neutral, builds every route
  routes/
    awards.ts          Award routes, on the SDK's award route schemas
    opportunities.ts   Opportunity routes, from the template
    common.ts          Pagination, error responses, response validation
  data/
    schema.ts          The opportunity schema: the Grants.gov plugin's
    snapshot.ts        The bundled sample's shape
    snapshot.json      The bundled sample (real data)
    repository.ts      The data seam
    memory.ts          In-memory repositories over the sample
  storage/
    d1.ts              D1 repositories, with the same rules as memory.ts
    rows.ts            Writing records and their filter/sort columns
  sync/                The full-coverage refresh
    workflow.ts        The Cloudflare Workflow: orders the steps
    steps.ts           Each step: list, fetch, download, match, store, prune
    sgg.ts             Simpler.Grants.gov listing and records
    usaspending-download.ts  USAspending bulk download, streamed
    fon.ts             Opportunity number matching
  pipeline/            The sample refresh, from cg-usaspending
    award.ts           USAspending award to CommonGrants AwardBase (shared)
    usaspending.ts     USAspending client (shared)
    run.ts, join.ts, sgg.ts, config.ts   Sampling for the bundled sample
migrations/            D1 migrations
scripts/refresh.ts     Rewrite the bundled sample
scripts/bootstrap.sh   One-time Cloudflare setup
test/                  Routes, D1 against memory, the refresh offline
```

## License

[CC0 1.0 Universal](LICENSE). Dependencies keep their own licenses.
