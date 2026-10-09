# CCS (Claude Code Switch) - TypeScript LLM Gateway

A lightweight, high-performance LLM proxy gateway daemon written in pure TypeScript for Node.js 22+ and Bun.

CCS normalizes LLM client requests and upstreams across Anthropic, OpenAI Chat, OpenAI Responses, and Google Gemini Interactions APIs, featuring wildcard route rules, exact model mapping, cyclic fallback rotation with error classification, pinned port listeners, real-time SSE stream transformation with token backfilling, transparent passthrough, and embedded SQLite metrics.

---

## Key Features

- **Bidirectional Format Translation**:
  - Anthropic Messages API (`/v1/messages`)
  - OpenAI Chat Completions API (`/v1/chat/completions`)
  - OpenAI Responses API (`/v1/responses`)
  - Google Gemini Interactions API (`/v1beta/interactions`)
- **Universal Canonical AST**: Eliminates $N \times M$ conversion matrices through a strongly-typed intermediate representation.
- **Deterministic Key Serialization**: Lexicographically sorted JSON properties at every depth for upstream prompt prefix-caching (Claude, GPT-4, DeepSeek).
- **Real-Time Streaming Engine**: Zero-copy Web Stream / SSE byte transformation with token extraction, reasoning delta mapping, and first-chunk model rewriting.
- **Transparent Byte-for-Byte Passthrough**: Automatically proxies matching OpenAI traffic directly without translation overhead when no routes or token caps are configured.
- **Resilience & Fault Tolerance**:
  - Three-state Circuit Breaker (`Closed` -> `Open` -> `Half-Open`) with 30-second cooldown to skip dead providers immediately.
  - Automatic `/v1/responses` 404 detection with instant retry on `/v1/chat/completions`.
  - Error classification: cycles on transient 5xx, 429, and auth errors; immediately relays 4xx client errors without useless cycling.
- **Pinned Port Listeners**: Run dedicated HTTP port listeners that route requests exclusively to a specific provider without fallback.
- **Zero Native Dependencies**: Uses Node.js 22+ built-in `node:sqlite` (`DatabaseSync`) in WAL mode for persistent statistics and request logging.
- **Live Configuration Hot-Reload**: Watches `$CCS_CONFIG_DIR/config.json` (or `~/.ccs/config.json`) with debouncing and atomic 0600 file replacement.

---

## Requirements

- **Node.js**: `v22.0.0` or later (or **Bun** `1.1+`)
- **Package Manager**: `pnpm`, `npm`, or `bun`

---

## Installation & Quickstart

```bash
git clone https://github.com/shrijit37/LLMBridge.git
cd LLMBridge

make setup     # install gateway + dashboard deps from lockfiles
make test      # 86 unit + integration tests
make lint      # tsc --noEmit for gateway and dashboard
make build     # compile gateway dist/ and dashboard/dist/
make dev       # run the gateway locally on :7896
```

`make` targets wrap `scripts/*`, and that is the contract CI uses too — CI
never calls a framework command directly.

By default, the daemon listens on `127.0.0.1:7896` (configurable via `config.json`).

## Deployment

`API` class, one container, deployed to Dokploy. **Builds happen only in GitHub
Actions**; Dokploy pulls the published image and never builds.

```text
push to dev → test → lint → build → push GHCR:<sha> (amd64+arm64)
            → Trivy scan → saveDockerProvider → redeploy → health gate
```

Live: <https://api.llmbridge.shrijit.tech> (`/health`, `/ready`)

| Endpoint | Purpose |
|---|---|
| `GET /health` | liveness; 200 as soon as the process is up |
| `GET /ready` | readiness; 503 until a provider set exists and the store is readable |

No migrations: the SQLite schema is created idempotently on boot, so
`make migrate` is an explicit no-op. The database holds per-request stats, not
authoritative user records, so it stays on a Docker volume rather than shared
PostgreSQL. See [STATE.md](./STATE.md) for the full rationale.

---

## Configuration

CCS loads its configuration from `$CCS_CONFIG_DIR/config.json` falling back to `~/.ccs/config.json`. The configuration schema is 100% compatible with the Rust version of CCS:

```json
{
  "current": "deepseek-main",
  "listen": "127.0.0.1:7896",
  "request_log_limit": 100,
  "providers": {
    "deepseek-main": {
      "base_url": "https://api.deepseek.com",
      "api_key": "$DEEPSEEK_API_KEY",
      "api_format": "openai",
      "api_version": "chat_completions",
      "enabled": true,
      "fallback": false,
      "inject_thinking_history": true,
      "routes": [
        {
          "id": "r1",
          "pattern": "claude-3-7-*",
          "target": "deepseek-reasoner",
          "enabled": true
        }
      ],
      "model_map": {
        "claude-3-5-sonnet": "deepseek-chat"
      }
    },
    "anthropic-fallback": {
      "base_url": "https://api.anthropic.com",
      "api_key": "$ANTHROPIC_API_KEY",
      "api_format": "anthropic",
      "enabled": true,
      "fallback": true
    },
    "pinned-gemini": {
      "base_url": "https://generativelanguage.googleapis.com",
      "api_key": "$GEMINI_API_KEY",
      "api_format": "gemini",
      "port": 7901,
      "enabled": true,
      "fallback": false
    }
  },
  "lanes": {
    "enabled": true,
    "proxy_base": "http://lane-egress",
    "ports": [8001, 8002, 8003, 8004],
    "ctl_url": "http://lane-egress:9100",
    "token": "$LANE_TOKEN"
  }
}

### Environment Variable Expansion
Any `api_key` or `extra_headers` value starting with `$` (e.g. `"$DEEPSEEK_API_KEY"`) is dynamically resolved from the process environment variables at request time.

---

## API Routes

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/messages` | Anthropic Messages API ingress |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions ingress |
| `POST` | `/v1/responses` | OpenAI Responses API ingress |
| `GET` | `/v1/models` | Content-negotiated model catalog (Anthropic or OpenAI list format) |
| `GET` | `/health` | Health check with uptime, active provider, and provider count |
| `GET` | `/stats` | Aggregated SQLite request, failure, and token metrics |
| `GET` | `/api/logs` | In-memory ring buffer of recent requests and responses |
| `GET` | `/api/lanes` | Live egress VPN lane status and health from lane-ctl |

---

## Architecture

```
                       ┌──────────────────────────────────────────────┐
                       │               CCS Gateway                    │
                       │                                              │
[ Anthropic Client ] ──┼──► POST /v1/messages                         │
                       │           │                                  │
[ OpenAI Chat Client ] ┼──► POST /v1/chat/completions                 │
                       │           │                                  │
[ Responses Client ]  ──┼──► POST /v1/responses                       │
                       │           ▼                                  │
                       │    [ Canonical AST ]                         │
                       │           │                                  │
                       │           ▼                                  │
                       │   [ Router & Breaker ]                       │
                       │           │                                  │
                       │           ├──────────────────────────────────┼──► Upstream Anthropic
                       │           ├──────────────────────────────────┼──► Upstream OpenAI Chat
                       │           ├──────────────────────────────────┼──► Upstream Responses
                       │           └──────────────────────────────────┼──► Upstream Gemini
                       │                                              │
                       │   [ SQLite WAL DB & Ring Buffer ]            │
                       └──────────────────────────────────────────────┘
```

---

## Testing

The project includes an automated test suite powered by `vitest`:

```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm test:watch
```

Tests cover:
- Lexicographical Canonical JSON serialization
- Wildcard glob pattern matching and route resolution
- Bidirectional request/response conversion across all wire formats
- SSE streaming translations, token capture, and first-chunk model rewriting
- Circuit breaker state transitions and fast-fail behavior
- SQLite persistence, schema migrations, and in-memory ring buffers
- End-to-end multi-provider proxy loops against synthetic mock upstreams

---

## GitHub config for the deploy pipeline

| Name | Type | Purpose |
|---|---|---|
| `DOKPLOY_API_KEY` | secret | triggers the redeploy via the Dokploy API |
| `IMAGE_NAME` | variable | lowercase image name (`llmbridge`) |
| `DOKPLOY_APPLICATION_ID` | variable | Dokploy app id |
| `DOKPLOY_URL` | variable | Dokploy control plane |
| `APP_URL` | variable | public hostname, used by the health gate |

Provider API keys are runtime config and are **not** stored in GitHub. They are
resolved from Infisical through Dokploy's secrets provider. `GITHUB_TOKEN` is
used implicitly for the GHCR push.

### Legacy compose stacks

This repo previously shipped `docker-compose.dokploy.yml`,
`docker-compose.dev.yml`, `docker-compose.prod.yml` and `docker-compose.yml`,
deployed by webhooks that **built the image on the production server**. Those
files are retained only until the GHCR pipeline is verified live, then
deleted: leaving four compose variants around is exactly how a future
accidental on-server build happens.

The old hostnames `ccs.shrijit.tech` and `ccs-dev.shrijit.tech` still resolve in
DNS but return 404 because no Dokploy domain is attached to them. They should
be removed once `api.llmbridge.shrijit.tech` is confirmed live.

### Rollback

Redeploy the previous SHA image; never rebuild. `scripts/health` will fail
fast if the previous image is not actually serving.

---
## License

MIT
