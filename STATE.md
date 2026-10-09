# STATE.md

Truthful current state. This file wins over any other doc in this repo when
they disagree. Last verified **2026-10-09**.

## Live endpoints (probed 2026-10-09 after deploy)

| What | URL | Status |
|---|---|---|
| Liveness | https://api.llmbridge.shrijit.tech/health | 200 `{"status":"ok","active_provider":"deepseek-dev","providers_count":1}` |
| Readiness | https://api.llmbridge.shrijit.tech/ready | 200 `{"status":"ready","database":"up"}` |
| Dashboard SPA | https://api.llmbridge.shrijit.tech/dashboard | 200 |
| Stats API | https://api.llmbridge.shrijit.tech/stats | 200 |
| Legacy host | https://ccs.shrijit.tech/health | **404** — stale DNS, no Dokploy route |
| Legacy dev host | https://ccs-dev.shrijit.tech/health | **404** — same |

The bare `/` path returns 404 by design: the dashboard is mounted at
`/dashboard`, not at the root. That is existing behaviour, not a defect.

CI run **37893737393** built and pushed the image, scanned it, and deployed.
Its health step failed on a 502 because the multi-arch image was still being
pulled on the ARM64 host; the service was healthy moments later. Fixed by
adding a retry-and-wait step before the health gate, and by asserting the
dashboard mount in `scripts/health`.

## Class

`API` — one container. The gateway serves both `/api/*` and the baked dashboard
SPA on port 7896, so a single hostname covers backend and UI. Per the domain
convention this is the `api.` slot; the SPA is served from the same origin
rather than split onto a second hostname, because splitting would mean two
containers for what is genuinely one process.

## Feature truth table

| Feature | State |
|---|---|
| LLM proxy gateway (Hono, `/v1/*` pass-through) | implemented |
| Provider routing + circuit breaker | implemented |
| Lane manager / egress pools | implemented |
| Dashboard SPA (React 19, baked into image) | implemented |
| `/health`, `/stats`, `/api/logs` | implemented |
| `/ready` (db reachable) | **missing** — no readiness endpoint |
| Unit + integration tests | implemented (86 tests, 10 files) |
| Typed coverage threshold | none |

## Data layer

SQLite via `node:sqlite` (`src/storage/db.ts`) on a Docker volume at
`/app/data`. Holds per-request stats and a ring-buffer log. **Deliberately not
shared PostgreSQL**: this is high-churn observability data with a single
writer, not authoritative user records. Putting it behind a network hop would
cost on the hot path for no gain.

## Migrations

None, by design. The SQLite schema is created idempotently by DDL on first
boot, so there is nothing for CI to run. `scripts/migrate` is an explicit
no-op that documents the exemption. This is a conscious deviation from
"stateful apps must have migrations"; if durable user data is ever added, this
moves to shared Postgres and gains real migrations.

## Secrets

Provider API keys are runtime config, not build-time. They belong in
Infisical and are mounted through Dokploy's Infisical secrets provider. CI
holds only `DOKPLOY_API_KEY` (deploy trigger) plus the implicit
`GITHUB_TOKEN` for the GHCR push.

## Deploy path

```text
push to dev → GitHub Actions (test → lint → build → GHCR push → Trivy scan
            → saveDockerProvider → redeploy → health gate)
```

Dokploy **pulls** the image; it never builds. Image is multi-arch
(amd64+arm64) because the server is ARM64.

Default branch is `dev`, so the deploy workflow triggers on `dev`.

## Hostname

`api.llmbridge.shrijit.tech` — Dokploy application `llmbridge-api`
(applicationId `likgsVQIIqZTxpwlF0d_x`) in Dokploy project `llmbridge`
(projectId `JajyPjpZyumnIaDtGar5A`).

## Health

`GET /health` returns 200 plus provider config. `scripts/health` asserts on
`"status":"ok"` in the body, not merely the HTTP code, because a gateway that
booted with zero providers is not meaningfully healthy.

## GitHub config

| Name | Type | Value |
|---|---|---|
| `DOKPLOY_API_KEY` | secret | deploy trigger only |
| `IMAGE_NAME` | variable | `llmbridge` (lowercase) |
| `DOKPLOY_APPLICATION_ID` | variable | `likgsVQIIqZTxpwlF0d_x` |
| `DOKPLOY_URL` | variable | `https://manage.shrijit.tech` |
| `APP_URL` | variable | `https://api.llmbridge.shrijit.tech` |

## History

- Previously deployed as `ccs` via `docker-compose.dokploy.yml`, a **compose
  stack that built on the production server**. That is the exact thing the
  standard forbids, and it is why `ccs.shrijit.tech` and `ccs-dev.shrijit.tech`
  returned 404: only DNS remained, with no backend behind it.
- Three overlapping workflows (`ci.yml`, `deploy-dev.yml`, `deploy-prod.yml`)
  with different triggers and no shared contract. Collapsed into one
  `deploy.yml` that calls `make *`.

## Cleanup completed 2026-10-09

- Deleted all four `docker-compose*.yml` files after the GHCR path was
  verified live, so no compose deploy can silently rebuild on the prod server
  again.
- Deleted the stale `ccs.shrijit.tech` and `ccs-dev.shrijit.tech` DNS records,
  which only pointed at a 404.
- `.gitignore` had `.env.*` swallowing the required `.env.example`; added a
  negation.

## Hygiene problems

- No Gitleaks / Dependabot config committed yet (Trivy runs in CI).
- No external uptime monitor on the hostname.
- Provider API keys are still managed outside Infisical; the Dokploy app has
  no secrets provider assigned yet, so `config.prod.json` on the volume is the
  effective source of provider keys. That is a real deviation from the
  standard and is the next thing to fix.
- Lint is `tsc --noEmit` only; no eslint/oxlint config in the repo.
- No Gitleaks / Dependabot config committed yet (Trivy runs in CI).
- No external uptime monitor on the hostname.