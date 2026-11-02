# CommonGrants API template — Hono

A working [CommonGrants](https://commongrants.org) API you can run in about a
minute, then point at your own data.

It starts as a complete, self-contained service: three opportunity endpoints
backed by bundled sample data, every request and response validated with the
published [`@common-grants/sdk`](https://www.npmjs.com/package/@common-grants/sdk)
schemas, and an OpenAPI 3.1 document generated from those same schemas at
`/openapi.json`. Nothing is stubbed out and nothing is left as an exercise —
connecting your own data is one interface with three methods.

Built with [Hono](https://hono.dev) and
[`@hono/zod-openapi`](https://github.com/honojs/middleware/tree/main/packages/zod-openapi).

---

## Prerequisites

- **Node.js 24** — the runtime. Use whichever installation or version manager
  you prefer; the included [`.nvmrc`](.nvmrc) is available for `nvm` users.
- **[pnpm](https://pnpm.io) 11.20.0** — the package manager and script runner.
  The version is pinned in `packageManager`.

No project-specific global packages, credentials, database or infrastructure
are required.

## Get started

Click **Use this template** at the top of
[this repository](https://github.com/common-grants/cg-api-template-hono) to
create your own, then:

```bash
git clone https://github.com/<you>/<your-api>.git
cd <your-api>
node --version # must report v24.x
pnpm --version # must report 11.20.0
pnpm install --frozen-lockfile
```

Check that everything works before you change anything:

```bash
pnpm run ci
```

That runs the static checks, the build, and the test suite with coverage.

Hosted CI runs that same command, then `pnpm run audit`.

Start the server:

```bash
pnpm run dev
```

Open <http://localhost:3000/docs> to browse the API in Swagger UI and try a
request from the browser. Or, in another terminal:

```bash
# A page of opportunities, most recently modified first
curl 'http://localhost:3000/common-grants/opportunities?pageSize=2'

# Filtered and sorted search
curl -X POST http://localhost:3000/common-grants/opportunities/search \
  -H 'Content-Type: application/json' \
  -d '{"filters":{"status":{"operator":"in","value":["open"]}},"sorting":{"sortBy":"title"}}'

# The OpenAPI 3.1 document, generated from the same schemas
curl http://localhost:3000/openapi.json
```

## Connect your own data

The bundled sample data lives behind a three-method interface. Implement that
interface against your database or upstream API and the routes, validation and
OpenAPI document all keep working unchanged.

**→ [PORTING.md](PORTING.md) is the walkthrough.** It covers replacing the
repository, mapping your ids onto stable UUIDs, handling date-valued fields in
filters and sorts, adding custom fields in one file, and which tests to keep.

## Endpoints

| Method | Path                                   | Description                                                                                                                 |
| ------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/common-grants/opportunities`         | Paginated list, most recent `lastModifiedAt` first                                                                          |
| `GET`  | `/common-grants/opportunities/{oppId}` | One opportunity by id                                                                                                       |
| `POST` | `/common-grants/opportunities/search`  | Filtered, sorted, paginated search                                                                                          |
| `GET`  | `/health`                              | Liveness check                                                                                                              |
| `GET`  | `/openapi.json`                        | The OpenAPI 3.1 document                                                                                                    |
| `GET`  | `/docs`                                | Swagger UI for the OpenAPI document; its assets load from the jsDelivr CDN (see [PORTING §9](PORTING.md#9-before-you-ship)) |

Every success envelope is parsed with its `@common-grants/sdk` schema before it
is sent, so repository output that drifts from the published shape becomes a
`500`, never a `200`. Error bodies carry no repository data; they are typed
against the SDK's `ErrorSchema` and checked against it in the tests. Requests
that do not match their schema get a `400` in the protocol's error shape; an
unknown but well-formed id gets a `404` in the protocol's not-found shape.

## Commands

| Command                             | What it does                                                    |
| ----------------------------------- | --------------------------------------------------------------- |
| `pnpm run dev`                      | Start the server with reload on change                          |
| `pnpm run build`                    | Compile to `dist/`                                              |
| `pnpm run start`                    | Run the compiled server on Node                                 |
| `pnpm run test`                     | Run the test suite                                              |
| `pnpm run test:coverage`            | Run the tests with a coverage report                            |
| `pnpm run checks`                   | Lint, format check and typecheck (never writes files)           |
| `pnpm run lint` / `pnpm run format` | Apply lint and formatting fixes                                 |
| `pnpm run audit`                    | The required dependency audit                                   |
| `pnpm run audit:report`             | Every severity, not just high                                   |
| `pnpm run ci`                       | The static/build/test suite: `checks`, `build`, `test:coverage` |

`pnpm run audit` is deliberately separate from `pnpm run ci` and runs
immediately after it in hosted CI.

pnpm installs dependencies and runs package scripts; the application runs on
Node 24. `pnpm run start` executes `node dist/index.js`.

## Structure

```
src/
  index.ts               Node entrypoint — the only file that knows about Node
  app.ts                 createApp({ repository }) — runtime-neutral factory
  http.ts                Shared error shapes
  routes/
    opportunities.ts     Route definitions, handlers, request/response validation
  data/
    schema.ts            The one opportunity schema — extend custom fields here
    repository.ts        The data seam: list / get / search
    fixtures.ts          Reference implementation over the bundled sample data
    opportunities.json   The bundled sample data
test/                    Vitest suites: fixtures, app, routes, OpenAPI
```

## Maintenance

This template is maintained by the [CommonGrants organization](https://github.com/common-grants).
File issues and pull requests here.

Projects created from this template are **independent**. There is no automatic
synchronization, no backports, and no source-maintainer responsibility for
derivative applications. You own your copy, including its dependency updates
and its `.github/` metadata — replace the issue templates and
contribution links with your own.

For how to keep your own copy current — and why updating your dependencies and
adopting template changes are two different jobs — see
[Keeping up to date](PORTING.md#8-keeping-up-to-date).

## Scope

This template is a starting point, not a framework. It deliberately ships
without deployment or auth recipes, a project generator, a live database
example, or release machinery. Add what your service needs.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md)
and the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[CC0 1.0 Universal](LICENSE). Dependencies keep their own licenses.
