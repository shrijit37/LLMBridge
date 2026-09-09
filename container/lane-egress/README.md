# lane-egress — Multi-Lane WireGuard Egress Container

One dedicated egress IP per "lane": each lane is its own network namespace with a
NordLynx (WireGuard) tunnel, fronted by gost. Clients speak HTTP CONNECT to
`container:800N`; the control plane (`lane_ctl.py`) exposes exactly three
administrative functions: **status**, **rotate**, **run_cmd**.

```
host / other containers
   │  HTTP CONNECT  http://container:8001..800N
   ▼
main netns ── gost tcp relay :800N ──► veth ──► netns wgN
        │                                       ├─ gost http proxy :8888
        │                                       ├─ wg1 (NordLynx, dedicated IP)
        │                                       └─ resolv.conf → 10.5.0.1 (tunnel DNS)
        └── lane-ctl :9100 (status / rotate / run_cmd)

main netns: iptables MASQUERADE 10.200.0.0/16 → eth0; ip_forward=1
```

## Files

| File | Purpose |
|---|---|
| `lane_ctl.py` | Control daemon (Python 3 stdlib only). Owns LANE STATE. |
| `entrypoint.sh` | Bootstraps netns/veth/gost/wg from `LANES` env, then execs lane-ctl. |
| `lanes.json.example` | Lane registry: port → {netns, ifname, gost_proxy_port}. |
| `test_lane_ctl.py` | Stdlib unit tests (`python3 -m unittest test_lane_ctl`). |

## API

Auth on every call: `Authorization: Bearer $LANE_TOKEN`. Errors are always
`{"error": "<machine_code>", "message": "<human>"}`.

### status — read-only, never mutates a lane

```
GET /v1/status?port=8001     # single lane
GET /v1/status?port=all      # {"lanes":[ ... ]}
```
Returns `curr_ip`, `prev_ip`, `rotated_today` (UTC-midnight counter),
`uptime_secs_on_curr_ip`, `last_rotate_at`, `state`
(`healthy|rotating|degraded|quarantined|unavailable`), handshake + probe health.
Unknown port → 404.

### rotate — asynchronous

```
POST /v1/rotate
{ "port":"8001", "blacklist":["45.132.194.7","185.212.149.0/24"], "reason":"http_429" }
→ 202 {"accepted":true,"job_id":"rot-…","port":"8001"}
→ 409 {"accepted":false,"error":"lane_already_rotating"}   # one rotation per lane
→ 404 unknown_lane / 400 invalid_blacklist

GET /v1/rotate/<job_id>
→ {"job_id","port","state":"running|done|failed","attempts","assigned_ip","error"}
```

Worker per attempt: pick candidate (≠ current server, ≠ other lanes' servers,
∉ blacklist, ∉ recent failures) → write config → bounce wg inside the netns →
wait handshake → probe real egress IP through tunnel → reject if blacklisted
(CIDR-aware, checked AFTER establishment) → commit.
Prepare–verify–commit: on failure the previous config is restored best-effort;
a failed rotation never silently destroys a working lane.

### run_cmd — ROOT ADMIN API

```
POST /v1/run_cmd  {"cmd":"wg show wg1","timeout_ms":5000}
→ {"exit_code":0,"stdout":"…","stderr":"…","duration_ms":93,"timed_out":false}
```
Hard timeout kills the whole process group; stdout/stderr capped at 256 KiB;
every invocation audit-logged (ts, token *hash*, cmd, exit, duration) — never
the token itself. Optional allowlist mode: `LANE_ALLOWLIST=wg,ip,curl,ping,cat,ss`.
Bind to an admin network only — this is privileged execution by design.

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `LANE_TOKEN` | required | Bearer token for all three functions |
| `LANE_LISTEN` | `0.0.0.0:9100` | Control-plane bind addr |
| `LANES_FILE` | `/etc/lane-egress/lanes.json` | Lane registry |
| `STATE_DIR` | `/var/lib/lane-egress` | state.json, jobs/, last_good/, exec-audit.log |
| `SERVER_LIST_CMD` | – | Command emitting NDJSON `{host,pubkey,port}` candidates |
| `NORD_TOKEN` | – | Alternative built-in NordVPN recommendations source |
| `WG_PRIVATE_KEY` | – | NordLynx private key used by rotate |
| `WG_ADDRESS` | `10.5.0.2/32` | Lane interface address |
| `PROBE_URL` | `https://api.ipify.org` | Egress verification endpoint |
| `LANE_ALLOWLIST` | unrestricted | run_cmd verb allowlist |
| `ROTATE_MAX_ATTEMPTS` | `5` | Candidate budget per job |

## Docker requirements

```yaml
cap_add: [NET_ADMIN, NET_RAW]
devices: [/dev/net/tun]
sysctls: { net.ipv4.ip_forward: 1 }
```

## State ownership (design contract)

- The **controller** owns lane state (which server/IP a lane uses).
- The **gateway** owns request state (retries, routing decisions).
- Gateway reacts to failures by consulting `/v1/status` and requesting
  `rotate`; it never touches WireGuard internals. In-flight requests during a
  bounce (~2–5s) must be treated as retryable by callers.

## Tests

```bash
python3 -m unittest test_lane_ctl -v   # 17 tests, no root required
```
