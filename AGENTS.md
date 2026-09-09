# Repository Guidelines

## Project Overview

`ccs-ts` is a high-performance, zero-native-compilation TypeScript LLM proxy gateway daemon. It provides a 100% backward-compatible drop-in replacement for the legacy Rust CCS daemon, normalizing traffic between diverse LLM wire protocols:
- **Anthropic Messages API** (`/v1/messages`)
- **OpenAI Chat Completions** (`/v1/chat/completions`)
- **OpenAI Responses API** (`/v1/responses`)
- **Google Gemini Interactions** (`/v1beta/interactions`)

Key capabilities include:
- Universal Canonical AST hub-and-spoke transformation layer.
- Resilient multi-provider fallback pooling with 3-state circuit breakers (`src/proxy/circuit-breaker.ts`).
- Transparent byte-for-byte passthrough for matched routes (`src/proxy/passthrough.ts`).
- Dynamic pinned port listener reconciliation (`src/server/listener.ts`).
- Docker VPN egress lane management with autonomous health rotation (`src/proxy/lane-manager.ts`).
- High-concurrency SQLite WAL metrics storage and in-memory ring-buffer logging with real-time SSE telemetry (`/events`).
- Embedded Vite + React + Tailwind dashboard (`/dashboard`).

---

## Architecture & Data Flow

```text
[Client: Claude Code / Cursor / Aider / OpenCode]
                         │
                         ▼
        [Hono HTTP Ingress: src/server/app.ts]
                         │
                         ▼
        [Canonical AST: src/transform/canonical/]
                         │
                         ▼
       [Router & Pool Resolution: src/proxy/router.ts]
                         │
                         ▼
     [Executor & Circuit Breaker: src/proxy/executor.ts]
        ├── Fast-fail if Breaker Open (30s cooldown)
        ├── Passthrough Check (bypass transform if identical)
        ├── Model & Route Mapping (src/config/matcher.ts)
        └── Target Transformer (Anthropic / OpenAI / Gemini)
                         │
                         ▼
       [Egress Dispatch: LaneManager ProxyAgent]
                         │
                         ▼
            [Upstream LLM Provider API]
                         │
                         ▼
     [Streaming / Buffered Interceptors & Observability]
        ├── SSE Bidirectional Parser/Emitter (src/transform/streaming/)
        ├── Non-Intrusive Token Tracker (trackTokensInStream)
        ├── Model Alias Rewriter (rewriteModelInStream)
        └── SQLite WAL Database (src/storage/db.ts) & SSE Event Bus
```

1. **Ingress**: `src/server/app.ts` parses incoming payloads and determines client format (`anthropic`, `openai_chat`, `openai_responses`).
2. **Canonicalization**: Inbound wire requests are converted into `CanonicalRequest` (`src/transform/canonical/types.ts`).
3. **Pool Resolution**: `src/proxy/router.ts` builds candidate provider pool starting from `config.current` followed by configured `fallback` providers (pinned port listeners disable fallback cycling).
4. **Execution Loop**: `executeProviderLoop` in `src/proxy/executor.ts` iterates through candidates, evaluating circuit breakers and resolving model aliases.
5. **Egress Dispatch**: Upstream requests are sent via native `fetch` over round-robin VPN proxy lanes (`src/proxy/lane-manager.ts`) if enabled.
6. **Streaming & Response Translation**: SSE responses are transformed on-the-fly without full-response buffering. Client-visible model names and usage tokens are preserved.
7. **Observability**: Request metadata, latency, and token metrics are written to SQLite in WAL mode and broadcast via Server-Sent Events (`/events`).

---

## Key Directories

```text
src/
├── config/             # Config types, atomic loader (0600), glob matcher, debounced watcher
├── events/             # Shared EventEmitter bus for real-time SSE events
├── proxy/              # Core proxy: executor loop, circuit breaker, router, passthrough, quota, lanes
├── server/             # Hono app, SSE streaming response handler, dynamic pinned port listeners
├── storage/            # node:sqlite DatabaseSync wrapper (WAL mode), memory ring buffer
└── transform/          # Canonical AST, wire transformers, streaming engine, thinking rectifier, models
    ├── anthropic/      # Anthropic Messages wire format <-> Canonical AST
    ├── canonical/      # Universal AST types, recursive lexicographical JSON serializer
    ├── gemini/         # Gemini Interactions wire format <-> Canonical AST
    ├── openai-chat/    # OpenAI Chat Completions wire format <-> Canonical AST
    ├── openai-responses/ # OpenAI Responses wire format <-> Canonical AST
    └── streaming/      # Byte-level SSE parser/emitter and bidirectional stream translators

dashboard/              # React + Vite + Tailwind home screen UI served at /dashboard
tests/                  # Vitest behavioral, contract, and integration test suites
```

---

## Development Commands

### Core Daemon

```bash
# Install dependencies
pnpm install

# Build TypeScript to dist/ (strict compilation)
pnpm build

# Run all test suites
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run a specific test suite
pnpm vitest run tests/round-trip-fidelity.test.ts
pnpm vitest run tests/integration-e2e.test.ts

# Start the gateway daemon locally (defaults to port 7896 or config.json)
pnpm start
```

### Dashboard UI

```bash
cd dashboard

# Start Vite dev server on port 5174 (proxies /api and /events to gateway on :7896)
pnpm dev

# Typecheck dashboard without emitting
pnpm typecheck

# Build production SPA assets to dashboard/dist/ (served by gateway at /dashboard)
pnpm build
```

---

## Code Conventions & Common Patterns

### 1. Universal Canonical AST (Hub-and-Spoke)
Never implement direct $N \times M$ vendor-to-vendor translations. All transformations flow through the intermediate representation:
$$\text{Vendor Inbound} \longrightarrow \text{Canonical IR} \longrightarrow \text{Vendor Outbound}$$
- Types defined in `src/transform/canonical/types.ts`: `CanonicalRequest`, `CanonicalResponse`, `CanonicalMessage`, `CanonicalContentBlock`, `CanonicalUsage`.
- Unrecognized or provider-specific fields are preserved in `extra: Record<string, unknown>` to guarantee zero information loss.

### 2. Lexicographically Sorted Canonical JSON
Upstream LLMs (Anthropic, OpenAI, DeepSeek) rely on prompt caching by exact byte-prefix matching.
- **Rule**: All tool definitions and serialized arguments MUST use `canonicalJsonString` (`src/transform/canonical/json.ts`).
- This recursively sorts all object keys lexicographically at every depth and preserves array ordering.

### 3. Error Classification & Provider Cycling
In `src/proxy/executor.ts`:
- **Client 4xx Errors** (excluding `401`, `403`, `404`, `429`): MUST NOT cycle providers. Relay upstream status and body directly to the client to avoid masking invalid requests.
- **Transient / Retryable Errors** (`5xx`, `429`): Increment failure counters and cycle to the next provider candidate.
- **Auth Errors** (`401`, `403`, `404`): Cycle up to `maxAuthFailures` (`Math.max(roundSize, 1)`), then abort.
- **Responses 404 Auto-Fallback**: If `/v1/responses` returns 404, automatically retry `/v1/chat/completions` on the same provider before failing over.

### 4. Zero-Native C++ Dependencies
The gateway runs on standard Node.js 22+ using native built-in capabilities:
- SQLite persistence uses `node:sqlite` (`DatabaseSync`) with `PRAGMA journal_mode = WAL`.
- Cryptography uses `node:crypto`.
- HTTP agent pooling and proxy tunneling use `undici` (`ProxyAgent`).
- Do NOT introduce native C++ modules (`better-sqlite3`, `node-canvas`, etc.) that complicate cross-platform deployment.

### 5. Non-Intrusive Stream Interception
When translating or monitoring SSE streams:
- Use standard Web Streams (`ReadableStream`, `TransformStream`).
- Usage tracking (`trackTokensInStream`) and model alias rewriting (`rewriteModelInStream`) must operate chunk-by-chunk without full-stream buffering.

### 6. Dependency Injection via AppContext
Server routes and listeners do not access globals. State is passed via `AppContext` (`src/server/app.ts`):
```ts
export interface AppContext {
  configWatcher: ConfigWatcher;
  db: GatewayDatabase;
  ringBuffer: RingBuffer<Record<string, unknown>>;
  circuitBreaker: CircuitBreaker;
  pinnedProviderName?: string;
  laneManager?: LaneManager;
}
```

---

## Important Files

| File Path | Description |
| :--- | :--- |
| `src/index.ts` | Daemon entry point; bootstraps database, watchers, Hono server, and handles `SIGINT`/`SIGTERM`. |
| `src/server/app.ts` | Hono router exposing `/v1/messages`, `/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/health`, `/stats`, `/events`, `/dashboard`. |
| `src/proxy/executor.ts` | Main execution loop (`executeProviderLoop`) with retry cycling, format translation, and streaming pipeline. |
| `src/proxy/router.ts` | Provider candidate pool construction and pinned port resolution (`resolveProviderPool`). |
| `src/proxy/circuit-breaker.ts` | 3-state breaker (`closed`, `open`, `half_open`) with 5-failure threshold and 30s cooldown. |
| `src/proxy/lane-manager.ts` | Connects to Docker `lane-egress` sidecar container (ports 8001–8004) with round-robin and rotation control. |
| `src/proxy/quota.ts` | Runs provider quota command (`sh -lc`) with 15s timeout and `$__API_KEY`, `$__BASE_URL`, `$__PROVIDER` env variables. |
| `src/config/types.ts` | TypeScript types matching the incumbent CCS JSON configuration format. |
| `src/config/loader.ts` | Config file loader with atomic writes (`fsyncSync`, `renameSync`, `0600`), default paths, and env expansion. |
| `src/config/watcher.ts` | Debounced (200ms) file watcher for live zero-downtime configuration reload. |
| `src/storage/db.ts` | SQLite schema and queries for provider stats, model stats, and pruned request logs. |
| `src/transform/canonical/types.ts` | Central canonical data types for requests, responses, tools, and usage. |
| `src/transform/canonical/json.ts` | Deterministic key-sorted JSON serializer for prompt caching stability. |
| `src/transform/thinking.ts` | DeepSeek/Anthropic reasoning history rectifier (`patchThinkingHistory`). |

---

## Runtime & Tooling Preferences

- **Runtime**: Node.js `^22.0.0` or Bun `1.1+` (ESM native, `node:sqlite`).
- **Package Manager**: `pnpm` (configured via `pnpm-workspace.yaml`).
- **TypeScript Configuration**: Strict compilation enforced via `tsconfig.json` (`strict: true`, `noImplicitAny: true`, `noUncheckedIndexedAccess: true`, `target: ES2022`, `module: NodeNext`).
- **Linter & Formatter**: Rely on strict TypeScript checks (`pnpm build`). Formatting follows StandardJS/Prettier conventions with single quotes and trailing commas.

---

## Testing & QA

### Framework & Configuration
- **Test Runner**: Vitest (`vitest.config.ts`), configured for Node environment with global test APIs (`describe`, `it`, `expect`).
- **Test Location**: All test files reside in `tests/` and end in `*.test.ts`.

### Test Suites Map

| Suite | File | Focus |
| :--- | :--- | :--- |
| **Round-Trip Fidelity** | `tests/round-trip-fidelity.test.ts` | Bidirectional semantic preservation (Claude ↔ IR ↔ Claude, OpenAI ↔ IR ↔ OpenAI, Gemini ↔ IR ↔ Gemini). |
| **Wire Transformers** | `tests/wire-transformers.test.ts` | Protocol conversion accuracy (tools, thinking, images, usage, models). |
| **Streaming Engine** | `tests/sse-streaming.test.ts` | Split-chunk SSE parsing, CRLF handling, streaming cross-conversions, token tapping. |
| **Proxy Engine** | `tests/proxy-engine.test.ts` | Circuit breaker state transitions, client error passthrough, quota execution. |
| **Egress Lanes** | `tests/lane-manager.test.ts` | Round-robin lane selection, 30s rotation cooldown, sidecar control plane. |
| **Storage & Stats** | `tests/storage-server.test.ts` | SQLite WAL persistence, log retention pruning, in-memory ring buffer. |
| **Canonical JSON** | `tests/canonical-json.test.ts` | Lexicographical key sorting, array preservation, empty object handling. |
| **Configuration** | `tests/config.test.ts` | Config loading, default generation, env expansion, atomic save (`0600`). |
| **End-to-End Integration**| `tests/integration-e2e.test.ts` | Live HTTP gateway server tests over loopback with mock upstreams. |
| **Dashboard Server** | `tests/dashboard-server.test.ts` | `/api/status` snapshot, `/events` live SSE stream, `/dashboard` SPA serving. |

### Testing Conventions
1. **Time-Dependent Logic**: Use `vi.useFakeTimers()` for circuit breaker timeouts and lane rotation cooldowns (`tests/proxy-engine.test.ts`).
2. **Filesystem Isolation**: Tests that write configs or SQLite databases MUST write to isolated temporary directories (`os.tmpdir()`) and clean up in `afterEach()`.
3. **Protocol Regression Defense**: Any modification to `src/transform/` MUST pass both `tests/wire-transformers.test.ts` and `tests/round-trip-fidelity.test.ts` before merging.

---

## Safety Rules & Operational Invariants

1. **Credential Hygiene**:
   - API keys and tokens must NEVER be logged, written to SQLite request logs, or exposed in `/api/providers`.
   - In `config.json`, store credentials using `$ENV_VAR` or `${ENV_VAR}` syntax. They are resolved dynamically in memory by `resolveApiKey`.
2. **Atomic Config Permissions**:
   - Configuration files (`~/.ccs/config.json`) contain sensitive route and provider info.
   - Updates performed by `writeConfigFile` MUST sync to disk (`fsyncSync`), rename atomically, and enforce file permissions `0o600`.
3. **Circuit Breaker Trip Safety**:
   - Circuit breakers trip after 5 consecutive failures and enter a 30-second cooldown.
   - Do not bypass breaker state for live traffic; single probe attempts are permitted only in `half_open` state.
4. **Client Error Transparency**:
   - Do NOT retry upstream providers when a 4xx error (other than 401, 403, 404, 429) is received. Immediately relay the error to the client.
5. **Egress Isolation**:
   - When egress lanes are active, requests must route through assigned `ProxyAgent` instances (`http://lane-egress:8001-8004`). Rotate failed lanes with 30s cooldowns.
