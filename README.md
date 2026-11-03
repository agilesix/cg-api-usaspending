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
script that first joined the two datasets. That script's pipeline lives on here
as the scheduled refresh.

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

## Where the data comes from, and how fresh it is

Each refresh:

1. Samples assistance awards from USAspending: the top 15 by amount and another 15 by
   award ID, for each of seven agencies that report opportunity numbers
   (HHS, Education, EPA, Justice, Interior, NSF, Energy), over the past year.
2. Keeps the awards that carry a real opportunity number.
3. Looks each number up on Simpler.Grants.gov and keeps the exact matches.
4. Turns each matched award into a CommonGrants `AwardBase` record and checks
   it against the SDK schema.

It is a sample, not every award: enough to show the link with real records.
`GET /snapshot` reports when the data was pulled, what it covers, and how many
records made it through each step.

The deployed API refreshes once a day. Running locally, it serves the
snapshot bundled at `src/data/snapshot.json`, so no API key or network is
needed.

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

### Refresh the data locally

Copy `.env.example` to `.env` and add a
[Simpler.Grants.gov API key](https://simpler.grants.gov/developer), then:

```bash
pnpm refresh
```

That rewrites `src/data/snapshot.json` from the live APIs. Commit it when you
want the bundled sample, and the tests that run against it, to move forward.
Settings such as the agencies and date window are read from the environment;
see [`src/pipeline/config.ts`](src/pipeline/config.ts).

## Endpoints

| Method | Path                                   | Description                                                     |
| ------ | -------------------------------------- | --------------------------------------------------------------- |
| `GET`  | `/common-grants/awards`                | Paginated list, most recent `lastModifiedAt` first              |
| `GET`  | `/common-grants/awards/{awdId}`        | One award, with the opportunity it resulted from                |
| `POST` | `/common-grants/awards/search`         | Text search, filters, sorting, pagination                       |
| `GET`  | `/common-grants/opportunities`         | Paginated list of the opportunities the awards link to          |
| `GET`  | `/common-grants/opportunities/{oppId}` | One opportunity, with the awards it resulted in                 |
| `POST` | `/common-grants/opportunities/search`  | Filtered, sorted, paginated search                              |
| `GET`  | `/snapshot`                            | When the data was pulled, what it covers, and the record counts |
| `GET`  | `/health`                              | Liveness check                                                  |
| `GET`  | `/openapi.json`                        | The OpenAPI 3.1 document                                        |
| `GET`  | `/docs`                                | Swagger UI                                                      |
| `GET`  | `/`                                    | Redirects to `/docs`                                            |
| `POST` | `/admin/sync`                          | Deployed only: run a refresh now (Bearer `SYNC_SECRET`)         |

Award search supports the protocol's default filters (`status`,
`opportunityId`, `awardDateRange`, `awardedAmountRange`) and sort keys. As in
the template, every success response is parsed with its SDK schema before it is
sent, so data that drifts from the published shape becomes a `500`, never a
`200`. Custom filters and sort keys are reported as not applied rather than
silently ignored.

## Deployment

Same setup as the state APIs: a Cloudflare Worker, a daily Cron trigger, and an
R2 bucket. There is no D1 database. A refresh produces one small snapshot file,
stored as `latest.json` (what the API serves) and as a dated copy under
`snapshots/`. A refresh that matches no awards is not stored, so a bad upstream
day leaves the last good snapshot in place.

| Piece                                                      | What it does                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| [`wrangler.jsonc`](wrangler.jsonc)                         | Worker, R2 bucket, daily Cron at 08:00 UTC, `usaspending.api.cg.a6lab.ai` |
| [`src/worker.ts`](src/worker.ts)                           | Serves `latest.json`, runs the scheduled refresh and `/admin/sync`        |
| [`scripts/bootstrap.sh`](scripts/bootstrap.sh)             | One-time setup: bucket, first deploy, Worker secrets, first refresh       |
| [`cd-production.yml`](.github/workflows/cd-production.yml) | Checks and deploys on every push to `main`                                |
| [`cd-preview.yml`](.github/workflows/cd-preview.yml)       | Uploads each PR as a preview version of the Worker                        |
| [`manual-sync.yml`](.github/workflows/manual-sync.yml)     | Runs a refresh on the deployed API from the Actions tab                   |

**One-time setup.** `scripts/bootstrap.sh` does all of it and is safe to re-run.
It creates the R2 bucket, deploys the Worker (which also creates the Cron and
the custom domain), saves `SGG_API_KEY` and `SYNC_SECRET` as Worker secrets, and
runs the first refresh. Run it locally: `pnpm exec wrangler login`, put
`SGG_API_KEY` and `SYNC_SECRET` in `.dev.vars`, then `pnpm run bootstrap`. Works
from any branch. It stays out of CI because creating the Worker and the bucket
needs more access than the per-Worker tokens below have.

CI/CD shares one account-owned API token, limited to this Worker with the
**Individual Workers: Editor** role (per-Worker roles need account-owned
tokens). That is enough to upload previews and to deploy, since deploys leave
the custom domain unchanged. If a production deploy ever fails with a 403 on
routes, add Zone → Workers Routes → Edit on `a6lab.ai`.

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
clean up when the PR closes. A preview shares production's R2 bucket and
secrets: it serves the same `latest.json`, and because it runs with
`ENVIRONMENT=preview` it never writes it (`/admin/sync` answers `403` and
background refreshes are off). Preview URLs are public. Two caveats:

- Previews only get a URL once a production deploy has applied
  `preview_urls: true` from `wrangler.jsonc`.
- While a preview is the Worker's newest version, `wrangler secret put` refuses
  to run until the next production deploy. Use `wrangler versions secret put`
  or re-run the bootstrap, which deploys before it sets secrets.

To try the Worker locally, put `SGG_API_KEY` and `SYNC_SECRET` in `.dev.vars`
and run `pnpm run dev:worker`. `wrangler dev --test-scheduled` also exposes
`/__scheduled` for triggering the Cron by hand.

## Commands

| Command               | What it does                                        |
| --------------------- | --------------------------------------------------- |
| `pnpm run dev`        | Start the Node server with reload on change         |
| `pnpm run dev:worker` | Run the Worker locally with `wrangler dev`          |
| `pnpm refresh`        | Rewrite `src/data/snapshot.json` from the live APIs |
| `pnpm run test`       | Run the test suite                                  |
| `pnpm run checks`     | Lint, format check and typecheck                    |
| `pnpm run ci`         | `checks`, `build`, `test:coverage`                  |
| `pnpm run audit`      | The required dependency audit                       |
| `pnpm run deploy`     | Deploy the Worker (CI does this on push to `main`)  |
| `pnpm run bootstrap`  | One-time Cloudflare setup (see Deployment)          |

## Structure

```
src/
  index.ts             Node entrypoint: serves the bundled snapshot
  worker.ts            Cloudflare entrypoint: R2, Cron, /admin/sync
  app.ts               createApp(): runtime-neutral, builds every route
  routes/
    awards.ts          Award routes, on the SDK's award route schemas
    opportunities.ts   Opportunity routes, from the template
    common.ts          Pagination, error responses, response validation
  data/
    schema.ts          The opportunity schema: the Grants.gov plugin's
    snapshot.ts        The snapshot file's shape
    snapshot.json      The bundled snapshot (real data, see /snapshot)
    repository.ts      The data seam
    memory.ts          In-memory repositories over a snapshot
  pipeline/            The refresh, from cg-usaspending
    run.ts             Sample, match, transform, validate
    config.ts          Settings and defaults
    usaspending.ts     USAspending client
    sgg.ts             Simpler.Grants.gov lookup via the Grants.gov plugin
    join.ts            The join on opportunity number
    award.ts           USAspending award to CommonGrants AwardBase
scripts/refresh.ts     Run a refresh from Node
scripts/bootstrap.sh   One-time Cloudflare setup
test/                  Routes, the bundled snapshot end to end, the refresh offline
```

## License

[CC0 1.0 Universal](LICENSE). Dependencies keep their own licenses.
