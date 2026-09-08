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
# Clone and install dependencies
git clone <repository_url> ccs-ts
cd ccs-ts
pnpm install

# Build TypeScript to dist/
pnpm build

# Run unit and integration tests (65 tests)
pnpm test

# Start the gateway daemon
pnpm start
```

By default, the daemon listens on `127.0.0.1:7896` (configurable via `config.json`).

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
  }
}
```

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

## License

MIT
