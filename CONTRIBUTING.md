# Contributing

Thanks for your interest in improving this template.

Before anything else, please read the [Code of Conduct](CODE_OF_CONDUCT.md).

> **Contributing to a project you generated from this template?** This file
> came along with the copy and points at _this_ repository. Replace it with
> your own guidance — see [PORTING.md §9](PORTING.md#9-before-you-ship).

## What belongs here

This repository is a **starting point**, not a framework. The best
contributions make the first hour easier or make the seams cleaner. Things that
are deliberately out of scope:

- deployment or auth recipes, a project generator
- a live database or upstream-API example
- release machinery, tags, changelogs
- protocol changes — those belong in
  [HHS/simpler-grants-protocol](https://github.com/HHS/simpler-grants-protocol)

If you are unsure whether an idea fits, open an issue before writing code.

## Reporting a bug

Open a [bug report](https://github.com/common-grants/cg-api-template-hono/issues/new/choose).
The most useful thing you can include is whether you saw it in a **fresh copy
of the template** or **after connecting your own data** — those are very
different problems.

## Development setup

You need Node 24 as the runtime and pnpm 11.20.0 as the package manager and
script runner. Use whichever Node installation or version manager you prefer;
`.nvmrc` is available for `nvm` users. The pnpm version is pinned in
`packageManager`.

```bash
node --version # must report v24.x
pnpm --version # must report 11.20.0
pnpm install --frozen-lockfile
pnpm run ci
```

`pnpm run ci` is the static checks, the build, and the test suite with
coverage. Get it passing before you open a pull request.

While you work:

| Command                             |                              |
| ----------------------------------- | ---------------------------- |
| `pnpm run dev`                      | Run the server with reload   |
| `pnpm run test`                     | Run the tests                |
| `pnpm run lint` / `pnpm run format` | Apply fixes                  |
| `pnpm run checks`                   | Verify without writing files |

## Making a change

1. **Branch from `main`.**
2. **Write the test first.** Every behavior change needs a test that fails
   before your change and passes after.
3. **Keep the seams intact.** Route handlers own HTTP concerns — envelopes,
   defaults, status codes. The repository owns data access. Nothing
   HTTP-shaped should cross `src/data/repository.ts`.
4. **Use the shared schema.** `src/data/schema.ts` is the single opportunity
   model. Response factories, tests and assertions all read from it, which is
   what makes the one-file custom-field extension work. Do not import
   `OpportunityBaseSchema` directly elsewhere.
5. **Do not weaken validation to make something pass.** No escape-hatch casts
   and no disabled rules to route around a type error. Full response envelopes
   are parsed before serialization on purpose.
6. **Update the docs you invalidated.** A change to the data seam usually means
   a change to `PORTING.md`.

## Pull requests

Fill in the [pull request template](.github/pull_request_template.md), and say
in "Context for reviewers" **how you verified the change** — the actual
commands and their output, not "tested locally".

A pull request runs one CI job: frozen install
(`pnpm install --frozen-lockfile`), static checks, build, tests with coverage,
and `pnpm audit --audit-level high` over runtime _and_ development dependencies.
There are no excepted advisories: every high or critical finding, and any
audit-service failure, blocks.

A maintainer reviews every pull request. Nothing is auto-merged.

## Dependencies

Dependencies are reviewed deliberately rather than updated automatically. Keep
SDK updates separate from routine tooling and framework updates because they can
carry protocol changes.

## License

Contributions are accepted under [CC0 1.0 Universal](LICENSE). If you include
code from elsewhere, say so in the pull request and keep its notices intact.
