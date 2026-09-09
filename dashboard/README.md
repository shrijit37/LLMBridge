# CCS Gateway Dashboard

React + Vite + TypeScript + shadcn/ui control plane for the CCS TypeScript LLM
gateway. Built on the incumbent ccMesh dashboard's **Unified-Dark-Stripe**
design language (true-black surfaces, `#0a/#11/#18` gray lift, single emerald
`#22c55e` primary, Inter + JetBrains Mono tabular numerals, 12px cards).

## Pages

| Page | What it shows |
| --- | --- |
| **Dashboard** | provider queue + Gateway & Egress Relay card (ProxyScene), stat cards, live requests |
| **Traffic Timeline** | live request activity over the last hour: stat cards + timeline feed |
| **Providers** | sanitized provider config, breaker state dots, runtime usage per provider |
| **Statistics** | provider / model / summary tabs + quota output snapshots |
| **Logs** | full request log explorer: filter by provider, limit, detail dialog with bodies |
| **Lane Egress** | VPN lane relay health, opaque lane-ctl doc rendered as-is + port pills |
| **Gateway Keys** | quota output snapshots + key policy summary |
| **Settings** | read-only live gateway config snapshot |
| **About** | version / uptime / infrastructure summary |

## Live updates (SSE)

The gateway exposes `GET /events` (Server-Sent Events). It emits two named
events mirroring the incumbent ccMesh wire format:

| event | payload | consumer |
| --- | --- | --- |
| `log` | request log record | request logs / timeline / dashboard monitor |
| `stats` | provider stats delta | stat cards, breakers, providers |

The dashboard subscribes with a single `EventSource("/events")` and falls back
to a 3s polling interval when the stream is unavailable.

## Endpoints consumed

| endpoint | purpose |
| --- | --- |
| `GET /health` | status, active provider, uptime |
| `GET /stats` | per-provider request/token/failure totals |
| `GET /api/logs?limit=N` | recent request log ring buffer |
| `GET /api/lanes` | egress lane health (opaque lane-ctl status) |
| `GET /api/models?providerId=` | model usage stats |
| `GET /api/providers` | sanitized provider configuration |
| `GET /api/breakers` | circuit breaker state per provider |
| `GET /api/status` | one-shot snapshot for first paint |
| `GET /events` | SSE live event feed |

## Run

```bash
# dev server (proxies /api,/events,... to the gateway on :7896)
npm run dev          # http://localhost:5174

# production build served by the gateway at /dashboard
npm run build        # dashboard/dist
```

The gateway serves the built bundle at `http://<gateway>/dashboard` when
`dashboard/dist` exists (see `src/server/app.ts`).

## Layout

```
src/
  pages/                9 pages + per-page _components
  components/business/  StatCard, RequestMonitor
  components/common/    PageHeader
  components/ui/        shadcn/ui components (ported from ccMesh/web)
  layouts/              AppLayout shell, SideNav, TopBar
  hooks/                useStatus/useStats/useModels/useProviders/useBreakers/...
  services/request.ts   REST + EventSource client (incumbent wire format)
  stores/               zustand layout store (view + sidebar state)
  lib/                  cn(), format helpers
```