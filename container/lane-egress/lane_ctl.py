#!/usr/bin/env python3
"""
lane-ctl — Multi-Lane WireGuard Egress Control Plane.

Exposes exactly three administrative functions:

  GET  /v1/status?port=8001|all   (read-only, never mutates a lane)
  POST /v1/rotate                 (async job; poll GET /v1/rotate/<job_id>)
  POST /v1/run_cmd                (root exec inside container; audit-logged)

Design contract (see repo docs):
  - The lane controller owns LANE STATE; the gateway owns REQUEST STATE.
  - Rotate is asynchronous: HTTP 202 means "accepted", not "assigned".
  - Prepare -> verify -> commit. A failed rotation must not destroy the
    previous working configuration without attempting a verified replacement.
  - Only one active rotation per lane; concurrent rotates are rejected (409).
  - Actual egress IP is always verified through the tunnel AFTER the new
    tunnel is up; Nord server identity is never assumed to equal egress IP.

Python 3 stdlib only — no pip dependencies.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Configuration (environment)
# ---------------------------------------------------------------------------

LANE_TOKEN = os.environ.get("LANE_TOKEN", "")
LISTEN_ADDR = os.environ.get("LANE_LISTEN", "0.0.0.0:9100")
LANES_FILE = os.environ.get("LANES_FILE", "/etc/lane-egress/lanes.json")
STATE_DIR = os.environ.get("STATE_DIR", "/var/lib/lane-egress")
PROBE_URL = os.environ.get("PROBE_URL", "https://api.ipify.org")
HANDSHAKE_MAX_AGE = int(os.environ.get("HANDSHAKE_MAX_AGE", "180"))
ROTATE_MAX_ATTEMPTS = int(os.environ.get("ROTATE_MAX_ATTEMPTS", "5"))
PROBE_TIMEOUT = int(os.environ.get("PROBE_TIMEOUT", "8"))
SERVER_LIST_CMD = os.environ.get("SERVER_LIST_CMD", "")  # emits NDJSON {host,pubkey,port}
NORD_TOKEN = os.environ.get("NORD_TOKEN", "")            # optional built-in fetch
LANE_MODE = os.environ.get("LANE_MODE", "wireguard").strip().lower()  # wireguard | socks5
SOCKS_USER = os.environ.get("SOCKS_USER", "")
SOCKS_PASS = os.environ.get("SOCKS_PASS", "")
# Zen surface probes: a candidate lane exit must pass EVERY configured surface
# before it is seeded/assigned, because we can't assume an egress zen accepts
# for chat completions also serves the Responses surface (and vice-versa).
# muse-spark rides the Responses surface only; big-pickle rides chat only.
PROBE_CHAT_URL = os.environ.get("PROBE_CHAT_URL", "https://opencode.ai/zen/v1/chat/completions")
PROBE_CHAT_MODEL = os.environ.get("PROBE_CHAT_MODEL", "big-pickle")
PROBE_RESP_URL = os.environ.get("PROBE_RESP_URL", "https://opencode.ai/zen/v1/responses")
PROBE_RESP_MODEL = os.environ.get("PROBE_RESP_MODEL", "muse-spark-1.3-contributor-free")
PROBE_BODY_CHAT = os.environ.get("PROBE_BODY_CHAT", "")  # optional full JSON body override
PROBE_BODY_RESP = os.environ.get("PROBE_BODY_RESP", "")
PROBE_SURFACES = [
    s.strip().lower()
    for s in os.environ.get("PROBE_SURFACES", "chat").split(",")
    if s.strip()
]
ALLOWLIST = [v.strip() for v in os.environ.get("LANE_ALLOWLIST", "").split(",") if v.strip()]
MAX_BODY_BYTES = 64 * 1024
MAX_OUTPUT_BYTES = 256 * 1024
FAILED_CANDIDATE_TTL = 600.0  # seconds to avoid a recently failed candidate

if not LANE_TOKEN:
    print("FATAL: LANE_TOKEN is required", file=sys.stderr)
    sys.exit(2)

STATES = ("healthy", "rotating", "degraded", "quarantined", "unavailable")

# ---------------------------------------------------------------------------
# Small utilities
# ---------------------------------------------------------------------------


def now_utc_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def utc_date() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def token_hash() -> str:
    """Short hash of the bearer token for audit logs — never the token itself."""
    return hashlib.sha256(LANE_TOKEN.encode()).hexdigest()[:12]


def atomic_write_json(path: str, data: Any) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, path)


def read_json(path: str, default: Any) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def sh(args: List[str], timeout: float = 20.0) -> Tuple[int, str, str]:
    """Run a command in the MAIN netns; capture bounded output."""
    try:
        p = subprocess.run(
            args, capture_output=True, timeout=timeout, text=True,
            errors="replace",
        )
        out = p.stdout or ""
        err = p.stderr or ""
        if len(out) > MAX_OUTPUT_BYTES:
            out = out[:MAX_OUTPUT_BYTES] + "\n...[truncated]"
        if len(err) > MAX_OUTPUT_BYTES:
            err = err[:MAX_OUTPUT_BYTES] + "\n...[truncated]"
        return p.returncode, out, err
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout after {timeout}s"
    except FileNotFoundError as e:
        return 127, "", str(e)


def netns_exec(netns: str, args: List[str], timeout: float = 20.0) -> Tuple[int, str, str]:
    return sh(["ip", "netns", "exec", netns] + args, timeout=timeout)


def ip_in_blacklist(ip: str, blacklist: List[str]) -> bool:
    """CIDR-aware membership check for exact IPv4/IPv6 and CIDR entries."""
    try:
        addr = ipaddress.ip_address(ip.strip())
    except ValueError:
        return False
    for entry in blacklist or []:
        entry = entry.strip()
        if not entry:
            continue
        try:
            if "/" in entry:
                net = ipaddress.ip_network(entry, strict=False)
                if addr.version == net.version and addr in net:
                    return True
            else:
                cand = ipaddress.ip_address(entry)
                if addr == cand:
                    return True
        except ValueError:
            continue  # malformed entries are ignored, never fatal
    return False


def resolve_host(host: str) -> Optional[str]:
    """Resolve candidate endpoint hostname in the MAIN netns (avoids tunnel DNS bootstrap)."""
    try:
        infos = socket.getaddrinfo(host, None, family=socket.AF_INET)
        return infos[0][4][0]
    except Exception:
        return None


class ExecResult:
    __slots__ = ("exit_code", "stdout", "stderr", "duration_ms", "timed_out")

    def __init__(self, exit_code: int, stdout: str, stderr: str,
                 duration_ms: int, timed_out: bool):
        self.exit_code = exit_code
        self.stdout = stdout
        self.stderr = stderr
        self.duration_ms = duration_ms
        self.timed_out = timed_out

    def to_json(self) -> Dict[str, Any]:
        return {
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "duration_ms": self.duration_ms,
            "timed_out": self.timed_out,
        }


# ---------------------------------------------------------------------------
# Lane registry + persistent state
# ---------------------------------------------------------------------------


class LaneRegistry:
    """Authoritative lane table from lanes.json."""

    def __init__(self, path: str):
        raw = read_json(path, {}) or {}
        lanes = raw.get("lanes") or {}
        if not isinstance(lanes, dict) or not lanes:
            raise SystemExit(f"FATAL: no lanes defined in {path}")
        self.lanes: Dict[str, Dict[str, Any]] = {}
        for port, cfg in lanes.items():
            self.lanes[str(port)] = {
                "netns": cfg["netns"],
                "ifname": cfg.get("ifname", "wg0"),
                "gost_proxy_port": int(cfg.get("gost_proxy_port", 8888)),
            }

    def ports(self) -> List[str]:
        return list(self.lanes.keys())

    def get(self, port: str) -> Optional[Dict[str, Any]]:
        return self.lanes.get(str(port))


class StateStore:
    """
    Persistent per-lane state + rotation counters + job records.

    Layout under STATE_DIR:
      state.json     — curr_ip/prev_ip/counters/server per lane
      jobs/<id>.json — one file per rotation job (survives restarts)
      last_good/<port>.conf — last verified working wg-quick config
      exec-audit.log — JSONL audit for run_cmd
    """

    def __init__(self, base_dir: str, ports: List[str]):
        self.base = base_dir
        self.jobs_dir = os.path.join(base_dir, "jobs")
        self.last_good_dir = os.path.join(base_dir, "last_good")
        os.makedirs(self.jobs_dir, exist_ok=True)
        os.makedirs(self.last_good_dir, exist_ok=True)

        self.path = os.path.join(base_dir, "state.json")
        disk = read_json(self.path, {}) or {}
        today = utc_date()
        counters = disk.get("counters") or {}
        # rotated_today resets at UTC midnight
        if disk.get("counter_date") != today:
            counters = {}

        self.lock = threading.Lock()
        self.data: Dict[str, Dict[str, Any]] = {}
        for port in ports:
            st = disk.get("lanes", {}).get(port, {})
            self.data[port] = {
                "curr_ip": st.get("curr_ip"),
                "prev_ip": st.get("prev_ip"),
                "server_host": st.get("server_host"),
                "last_rotate_at": st.get("last_rotate_at"),
                "state": st.get("state", "unavailable"),
                "probe_ok": False,
                "probe_latency_ms": None,
                "handshake_ok": False,
                "handshake_age_secs": None,
                "failed_candidates": {},  # host -> epoch ts
            }
        self.counter_date = today
        self.counters: Dict[str, int] = {p: int(counters.get(p, 0)) for p in ports}
        self.save()

    def save(self) -> None:
        payload = {
            "counter_date": self.counter_date,
            "counters": self.counters,
            "lanes": {
                p: {
                    "curr_ip": s["curr_ip"],
                    "prev_ip": s["prev_ip"],
                    "server_host": s["server_host"],
                    "last_rotate_at": s["last_rotate_at"],
                    "state": s["state"],
                }
                for p, s in self.data.items()
            },
        }
        atomic_write_json(self.path, payload)

    def snapshot(self, port: str) -> Dict[str, Any]:
        with self.lock:
            s = self.data[port]
            return dict(s)

    # -- counters -----------------------------------------------------------

    def bump_rotation(self, port: str) -> int:
        with self.lock:
            today = utc_date()
            if today != self.counter_date:
                self.counter_date = today
                self.counters = {p: 0 for p in self.counters}
            self.counters[port] = self.counters.get(port, 0) + 1
            n = self.counters[port]
            self.save()
            return n

    def rotations_today(self, port: str) -> int:
        with self.lock:
            if utc_date() != self.counter_date:
                return 0
            return self.counters.get(port, 0)

    # -- mutation helpers ---------------------------------------------------

    def update(self, port: str, **fields: Any) -> None:
        with self.lock:
            self.data[port].update(fields)
            self.save()

    def add_failed_candidate(self, port: str, host: str) -> None:
        with self.lock:
            fc = self.data[port]["failed_candidates"]
            fc[host] = time.time()
            # prune expired
            for h in [h for h, t in fc.items() if time.time() - t > FAILED_CANDIDATE_TTL]:
                del fc[h]

    def recent_failures(self, port: str) -> Dict[str, float]:
        with self.lock:
            now = time.time()
            return {h: t for h, t in self.data[port]["failed_candidates"].items()
                    if now - t <= FAILED_CANDIDATE_TTL}

    # -- last-good config ---------------------------------------------------

    def store_last_good(self, port: str, conf_text: str) -> None:
        with open(os.path.join(self.last_good_dir, f"{port}.conf"), "w") as f:
            f.write(conf_text)

    def load_last_good(self, port: str) -> Optional[str]:
        path = os.path.join(self.last_good_dir, f"{port}.conf")
        try:
            with open(path, "r") as f:
                return f.read()
        except Exception:
            return None

    # -- jobs ---------------------------------------------------------------

    def job_path(self, job_id: str) -> str:
        safe = re.sub(r"[^A-Za-z0-9_-]", "", job_id)
        return os.path.join(self.jobs_dir, safe + ".json")

    def save_job(self, job: Dict[str, Any]) -> None:
        atomic_write_json(self.job_path(job["job_id"]), job)

    def load_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        return read_json(self.job_path(job_id), None)

    def mark_running_jobs_interrupted(self) -> None:
        """Control-plane restart: running jobs can no longer be observed live."""
        try:
            for name in os.listdir(self.jobs_dir):
                if not name.endswith(".json"):
                    continue
                job = read_json(os.path.join(self.jobs_dir, name), None)
                if isinstance(job, dict) and job.get("state") == "running":
                    job["state"] = "failed"
                    job["error"] = "control_plane_restarted"
                    atomic_write_json(os.path.join(self.jobs_dir, name), job)
        except FileNotFoundError:
            pass


# ---------------------------------------------------------------------------
# WireGuard / verification primitives
# ---------------------------------------------------------------------------


def wg_conf_text(privkey: str, address_cidr: str, dns: Optional[str],
                 pubkey: str, endpoint_ip: str, endpoint_port: int) -> str:
    lines = [
        "[Interface]",
        f"PrivateKey = {privkey}",
        f"Address = {address_cidr}",
    ]
    if dns:
        lines.append(f"DNS = {dns}")
    lines += [
        "",
        "[Peer]",
        f"PublicKey = {pubkey}",
        "AllowedIPs = 0.0.0.0/0,::/0",
        f"Endpoint = {endpoint_ip}:{endpoint_port}",
        "PersistentKeepalive = 25",
    ]
    return "\n".join(lines) + "\n"


def verify_handshake(netns: str, ifname: str) -> Tuple[bool, Optional[int]]:
    """(ok, age_seconds) from `wg show <if> latest-handshakes` inside the netns."""
    rc, out, _ = netns_exec(netns, ["wg", "show", ifname, "latest-handshakes"], timeout=10)
    if rc != 0 or not out.strip():
        return False, None
    try:
        ts = int(out.strip().split()[1])
    except Exception:
        return False, None
    age = max(0, int(time.time()) - ts)
    return age <= HANDSHAKE_MAX_AGE, age


def probe_egress(netns: str) -> Tuple[bool, Optional[int], Optional[str]]:
    """External connectivity + public IP THROUGH the lane tunnel.

    Observation only — never mutates lane configuration.
    Returns (ok, latency_ms, egress_ip).
    """
    start = time.monotonic()
    rc, out, _ = netns_exec(
        netns, ["curl", "-fsS", "-m", str(PROBE_TIMEOUT), PROBE_URL], timeout=PROBE_TIMEOUT + 5)
    latency = int((time.monotonic() - start) * 1000)
    ip = out.strip() if rc == 0 else None
    ok = rc == 0 and bool(ip) and ip.replace(".", "").replace(":", "").isalnum()
    return ok, latency if ok else None, ip if ok else None


def probe_egress_via_proxy(port: str) -> Tuple[bool, Optional[int], Optional[str]]:
    """SOCKS5 mode: probe egress IP through the lane's http proxy on :port."""
    start = time.monotonic()
    rc, out, _ = sh(
        ["curl", "-fsS", "-m", str(PROBE_TIMEOUT), "--proxy", f"http://127.0.0.1:{port}", PROBE_URL],
        timeout=PROBE_TIMEOUT + 5,
    )
    latency = int((time.monotonic() - start) * 1000)
    ip = out.strip() if rc == 0 else None
    ok = rc == 0 and bool(ip) and ip.replace(".", "").replace(":", "").isalnum()
    return ok, latency if ok else None, ip if ok else None


def gost_alive(port: str) -> bool:
    rc, out, _ = sh(["pgrep", "-f", f"gost.*:{port}(/| )"], timeout=5)
    return rc == 0 and bool(out.strip())


def ensure_socks_creds() -> Tuple[str, str]:
    """Return (user, pass) for SOCKS, fetching from Nord credentials API if needed."""
    global SOCKS_USER, SOCKS_PASS
    if SOCKS_USER and SOCKS_PASS:
        return SOCKS_USER, SOCKS_PASS
    if not NORD_TOKEN:
        return "", ""
    # Credentials API is not Cloudflare-blocked (GET, proven working)
    req = urllib.request.Request(
        "https://api.nordvpn.com/v1/users/services/credentials",
        headers={"Authorization": "Basic " + __import__("base64").b64encode(f"token:{NORD_TOKEN}".encode()).decode()},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
            u = data.get("username") or ""
            p = data.get("password") or ""
            SOCKS_USER, SOCKS_PASS = u, p
            return u, p
    except Exception as e:
        log_event("warn", f"socks creds fetch failed: {e}")
        return "", ""


class CandidateProvider:
    """Supplies candidate egress servers as dicts: {host, pubkey, port}.

    Two sources, in priority order:
      1. SERVER_LIST_CMD — external NDJSON emitter (user-provided tooling).
      2. NORD_TOKEN      — built-in NordVPN recommendations API (wireguard_udp).
    """

    def __init__(self):
        self._cache: List[Dict[str, Any]] = []
        self._cache_ts = 0.0
        self._lock = threading.Lock()

    def get_candidates(self) -> List[Dict[str, Any]]:
        with self._lock:
            if self._cache and time.time() - self._cache_ts < 300:
                return list(self._cache)
            cands: List[Dict[str, Any]] = []
            if SERVER_LIST_CMD:
                rc, out, err = sh(["bash", "-lc", SERVER_LIST_CMD], timeout=30)
                if rc == 0:
                    for line in out.splitlines():
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            row = json.loads(line)
                            if row.get("host"):
                                entry: Dict[str, Any] = {"host": row["host"], "port": int(row.get("port", 1080 if LANE_MODE == "socks5" else 51820))}
                                if row.get("pubkey"):
                                    entry["pubkey"] = row["pubkey"]
                                cands.append(entry)
                        except Exception:
                            continue
                else:
                    log_event("warn", f"SERVER_LIST_CMD failed rc={rc}: {err[:200]}")
            if not cands and NORD_TOKEN:
                cands = self._fetch_nord() if LANE_MODE != "socks5" else self._fetch_socks()
            elif not cands and LANE_MODE == "socks5":
                cands = self._fetch_socks()
            if cands:
                self._cache = cands
                self._cache_ts = time.time()
            return list(cands)

    @staticmethod
    def _fetch_nord() -> List[Dict[str, Any]]:
        url = ("https://api.nordvpn.com/v1/servers/recommendations"
               "?filters[servers_technologies][identifier]=wireguard_udp&limit=64")
        req = urllib.request.Request(url, headers={"User-Agent": "lane-ctl/1"})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode())
        except Exception as e:
            log_event("warn", f"NordVPN recommendations fetch failed: {e}")
            return []
        out: List[Dict[str, Any]] = []
        for srv in data:
            try:
                hostname = srv.get("hostname")
                pub = ""
                # Live API shape: the WG public key sits under
                # technologies[].metadata[].{name:"public_key"} — the old
                # top-level `service.public_key` no longer exists.
                for t in srv.get("technologies") or []:
                    if t.get("identifier") != "wireguard_udp":
                        continue
                    for m in t.get("metadata") or []:
                        if m.get("name") == "public_key":
                            pub = m.get("value") or ""
                            break
                if hostname and pub:
                    out.append({"host": hostname, "pubkey": pub, "port": 51820})
            except Exception:
                continue
        return out

    @staticmethod
    def _fetch_socks() -> List[Dict[str, Any]]:
        url = "https://api.nordvpn.com/v1/servers?limit=64&filters%5Bservers_technologies%5D%5Bidentifier%5D=socks"
        req = urllib.request.Request(url, headers={"User-Agent": "lane-ctl/1"})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode())
        except Exception as e:
            log_event("warn", f"NordVPN socks list fetch failed: {e}")
            return []
        out: List[Dict[str, Any]] = []
        for srv in data:
            try:
                host = srv.get("hostname") or srv.get("ip_address")
                if host:
                    out.append({"host": host, "port": 1080})
            except Exception:
                continue
        return out


def _gost_restart_socks(port: str, host: str) -> bool:
    user, pwd = ensure_socks_creds()
    if not user:
        log_event("warn", f"socks creds unavailable for port {port}")
        return False
    # URL-encode creds
    import urllib.parse

    u = urllib.parse.quote(user, safe="")
    p = urllib.parse.quote(pwd, safe="")
    sh(["pkill", "-f", f"gost.*:{port}(/| )"], timeout=5)
    time.sleep(0.7)
    # ensure any leftover killed
    sh(["pkill", "-9", "-f", f"gost.*:{port}(/| )"], timeout=5)
    cmd = f"nohup gost -L http://:{port} -F socks5://{u}:{p}@{host}:1080 >/tmp/gost-{port}.log 2>&1 &"
    sh(["bash", "-lc", cmd], timeout=5)
    time.sleep(1.2)
    return gost_alive(port)


def _probe_socks(host: str, url: str, body: str) -> bool:
    """Direct zen probe through the candidate SOCKS exit (without touching the lane).
    curl -f fails on any HTTP >=400 (exit 22)."""
    user, pwd = ensure_socks_creds()
    if not user:
        return False
    import secrets
    import urllib.parse

    u = urllib.parse.quote(user, safe="")
    p = urllib.parse.quote(pwd, safe="")
    ses = f"ses_{secrets.token_hex(8)}"
    msg = f"msg_{secrets.token_hex(8)}"
    rc, _, _ = sh(
        ["curl", "-fsS", "-m", "25", "--socks5-hostname", f"{user}:{pwd}@{host}:1080",
         url,
         "-H", "Authorization: Bearer public",
         "-H", "Content-Type: application/json",
         "-H", "User-Agent: opencode/1.18.27",
         "-H", "x-opencode-client: cli",
         "-H", f"x-opencode-session: {ses}",
         "-H", f"x-opencode-request: {msg}",
         "-d", body],
        timeout=30,
    )
    return rc == 0


def _probe_default_body(surface: str) -> str:
    """Tiny real request body for a probe surface (genuine minimal request)."""
    if surface == "chat":
        return json.dumps({
            "model": PROBE_CHAT_MODEL,
            "messages": [{"role": "user", "content": "hi"}],
            "max_tokens": 16,
        })
    return json.dumps({
        "model": PROBE_RESP_MODEL,
        "input": [{"role": "user", "content": [{"type": "input_text", "text": "hi"}]}],
        "max_output_tokens": 16,
    })

def _prevalidate_socks_candidate(host: str) -> bool:
    """Dual-surface gate: the candidate must pass EVERY configured probe surface.

    A real zen request, not /v1/models: a burned exit still returns 200 on the
    admission-light models endpoint while zen refuses it for the surface (500).
    We probe both the chat surface and the Responses surface because a model
    rides exactly one of them and we don't yet know whether an egress zen
    accepts for one also serves the other."""
    for surface in PROBE_SURFACES:
        if surface == "chat":
            url = PROBE_CHAT_URL
            body = PROBE_BODY_CHAT or _probe_default_body("chat")
        elif surface == "responses":
            url = PROBE_RESP_URL
            body = PROBE_BODY_RESP or _probe_default_body("responses")
        else:
            print(f"WARN: unknown PROBE_SURFACES entry {surface!r}; skipping", file=sys.stderr)
            continue
        if not _probe_socks(host, url, body):
            return False
    return True


# ---------------------------------------------------------------------------
# Lane manager: status assembly + rotation worker
# ---------------------------------------------------------------------------


class LaneManager:
    def __init__(self, registry: LaneRegistry, store: StateStore):
        self.registry = registry
        self.store = store
        self.provider = CandidateProvider()
        # One lock per lane serializes mutations (spec: concurrent mutations
        # to the same lane are serialized; other lanes unaffected).
        self.lane_locks: Dict[str, threading.Lock] = {
            p: threading.Lock() for p in registry.ports()
        }
        self.rotating: Dict[str, Optional[str]] = {p: None for p in registry.ports()}
        self.privkey: str = os.environ.get("WG_PRIVATE_KEY", "")
        self.address_cidr: str = os.environ.get("WG_ADDRESS", "10.5.0.2/32")
        for p in registry.ports():
            if not self.privkey:
                # Fall back to existing conf on disk so rotate can reuse keys.
                break

    # ---------------- STATUS (read-only) ----------------------------------

    def status_lane(self, port: str) -> Dict[str, Any]:
        cfg = self.registry.get(port)
        snap = self.store.snapshot(port)
        if LANE_MODE == "socks5":
            hs_ok = gost_alive(port)
            hs_age = 0 if hs_ok else None
            self.store.update(port, handshake_ok=hs_ok, handshake_age_secs=hs_age)
        else:
            hs_ok, hs_age = verify_handshake(cfg["netns"], cfg["ifname"])
            self.store.update(port, handshake_ok=hs_ok, handshake_age_secs=hs_age)
        last_rotate = snap.get("last_rotate_at")
        uptime = None
        if last_rotate:
            try:
                t = datetime.strptime(last_rotate, "%Y-%m-%dT%H:%M:%SZ").replace(
                    tzinfo=timezone.utc).timestamp()
                uptime = int(time.time() - t)
            except Exception:
                uptime = None
        state = snap.get("state", "unavailable")
        if state == "rotating" and self.rotating.get(port) is None:
            state = snap.get("prev_state_override") or "degraded"  # stale flag recovery
        return {
            "port": port,
            "netns": cfg["netns"],
            "curr_ip": snap.get("curr_ip"),
            "prev_ip": snap.get("prev_ip"),
            "rotated_today": self.store.rotations_today(port),
            "uptime_secs_on_curr_ip": uptime,
            "last_rotate_at": last_rotate,
            "state": state,
            "handshake_ok": hs_ok,
            "handshake_age_secs": hs_age,
            "probe_ok": snap.get("probe_ok"),
            "probe_latency_ms": snap.get("probe_latency_ms"),
        }

    def background_refresher(self) -> None:
        """Periodically refresh probe results and initial lane verification.

        Probing is observation-only; it never mutates lane configuration.
        """
        first_pass_done = {p: False for p in self.registry.ports()}
        while True:
            for port in self.registry.ports():
                cfg = self.registry.get(port)
                snap = self.store.snapshot(port)
                if snap.get("state") == "rotating":
                    continue
                if LANE_MODE == "socks5":
                    ok, latency, ip = probe_egress_via_proxy(port)
                    hs_ok = gost_alive(port)
                else:
                    ok, latency, ip = probe_egress(cfg["netns"])
                    hs_ok, _ = verify_handshake(cfg["netns"], cfg["ifname"])
                fields: Dict[str, Any] = {"probe_ok": ok, "probe_latency_ms": latency}
                if ok and ip:
                    fields["curr_ip"] = ip
                fields["handshake_ok"] = hs_ok
                if not first_pass_done[port]:
                    first_pass_done[port] = True
                    if ok:
                        fields["state"] = "healthy"
                    elif hs_ok:
                        fields["state"] = "degraded"
                    else:
                        fields["state"] = "unavailable"
                    if ok and ip and not snap.get("curr_ip"):
                        fields["curr_ip"] = ip
                elif snap.get("state") == "healthy" and not ok:
                    fields["state"] = "degraded"
                elif snap.get("state") == "degraded" and ok:
                    fields["state"] = "healthy"
                self.store.update(port, **fields)
            time.sleep(60)

    # ---------------- ROTATE ----------------------------------------------

    def submit_rotate(self, port: str, blacklist: List[str], reason: str) -> Tuple[int, Dict[str, Any]]:
        if port not in self.registry.lanes:
            return 404, {"accepted": False, "error": "unknown_lane",
                         "message": f"no such lane: {port}"}
        for entry in blacklist or []:
            entry = entry.strip()
            if not entry:
                continue
            try:
                if "/" in entry:
                    ipaddress.ip_network(entry, strict=False)
                else:
                    ipaddress.ip_address(entry)
            except ValueError:
                return 400, {"accepted": False, "error": "invalid_blacklist",
                             "message": f"bad blacklist entry: {entry}"}

        lock = self.lane_locks[port]
        if not lock.acquire(blocking=False):
            return 409, {"accepted": False, "error": "lane_already_rotating",
                         "message": f"lane {port} already has an active rotation"}
        try:
            if self.rotating.get(port):
                return 409, {"accepted": False, "error": "lane_already_rotating",
                             "message": f"lane {port} already has an active rotation"}
            job_id = "rot-" + os.urandom(4).hex()
            self.rotating[port] = job_id
            job = {
                "job_id": job_id, "port": port, "state": "running",
                "attempts": 0, "assigned_ip": None, "error": None,
                "reason": reason, "blacklist": blacklist,
                "created_at": now_utc_iso(),
            }
            self.store.save_job(job)
            t = threading.Thread(target=self._rotation_worker,
                                 args=(port, job), daemon=True, name=f"rotate-{port}")
            t.start()
            log_event("info", f"rotate accepted port={port} job={job_id} reason={reason}")
            return 202, {"accepted": True, "job_id": job_id, "port": port}
        finally:
            lock.release()

    def _set_state(self, port: str, state: str) -> None:
        self.store.update(port, state=state)

    def _rotation_worker(self, port: str, job: Dict[str, Any]) -> None:
        cfg = self.registry.get(port)
        netns, ifname = cfg["netns"], cfg["ifname"]
        blacklist: List[str] = job.get("blacklist") or []
        old_snap = self.store.snapshot(port)
        old_server = old_snap.get("server_host")
        assigned: Optional[str] = None
        error: Optional[str] = None
        self._set_state(port, "rotating")

        try:
            candidates = self.provider.get_candidates()
            others = {self.store.snapshot(p).get("server_host")
                      for p in self.registry.ports() if p != port}
            recent_fail = self.store.recent_failures(port)

            ranked = []
            for c in candidates:
                if c["host"] == old_server:
                    continue
                if c["host"] in others:
                    continue
                if c["host"] in recent_fail:
                    continue
                ranked.append(c)

            attempts = 0
            for cand in ranked:
                if attempts >= ROTATE_MAX_ATTEMPTS:
                    error = "no_usable_egress_candidate"
                    break
                attempts += 1
                job["attempts"] = attempts
                self.store.save_job(job)

                egress_ip, conf_text = self._try_candidate(cand, netns, ifname, blacklist)
                if egress_ip:
                    # ---- COMMIT ----
                    self.store.store_last_good(port, conf_text)
                    assigned = egress_ip
                    self.store.update(port, curr_ip=egress_ip,
                                      prev_ip=old_snap.get("curr_ip"),
                                      server_host=cand["host"],
                                      last_rotate_at=now_utc_iso(),
                                      probe_ok=True)
                    self.store.bump_rotation(port)
                    self._set_state(port, "healthy")
                    log_event("info", f"rotate done port={port} job={job['job_id']} "
                                      f"attempts={attempts} ip={egress_ip}")
                    break
                else:
                    self.store.add_failed_candidate(port, cand["host"])
            else:
                if attempts >= ROTATE_MAX_ATTEMPTS and not assigned:
                    error = error or "candidate_budget_exhausted"
                elif not candidates:
                    error = "no_rotation_capacity"

            if not assigned:
                # Roll back to last known good config, best effort.
                rc, out, err = self._rollback(netns, ifname, port)
                prev_state = "quarantined" if rc != 0 else "degraded"
                self._set_state(port, prev_state)
                error = error or "verification_failed"
                log_event("warn", f"rotate FAILED port={port} job={job['job_id']} "
                                  f"attempts={attempts} error={error} rollback_rc={rc}")
        except Exception as e:  # worker must never die silently
            error = "internal_error"
            log_event("error", f"rotate exception port={port}: {traceback.format_exc()[-400:]}")
            self._set_state(port, "quarantined")
        finally:
            self.rotating[port] = None
            job["state"] = "done" if assigned else "failed"
            job["assigned_ip"] = assigned
            job["error"] = error
            job["finished_at"] = now_utc_iso()
            self.store.save_job(job)

    def _try_candidate(self, cand: Dict[str, Any], netns: str, ifname: str,
                       blacklist: List[str]) -> Tuple[Optional[str], str]:
        """PREPARE -> VERIFY for one candidate. Returns (egress_ip|None, conf_text).

        WG mode: bounces wg-quick inside netns.
        SOCKS5 mode: pre-validates directly, then restarts the lane's gost.
        """
        if LANE_MODE == "socks5":
            # Port is encoded in netns name ns<port> or via lookup
            # Derive lane port from netns (ns8001 -> 8001) or fallback
            port = None
            for p, cfg in self.registry.lanes.items():
                if cfg["netns"] == netns:
                    port = p
                    break
            if not port:
                # No netns mapping in socks mode (main-netns lanes) — try ifname fallback
                port = ifname.replace("wg", "") if ifname.startswith("wg") else None
            if not port:
                log_event("warn", f"socks5: cannot map netns {netns} to port")
                return None, ""
            # Pre-validate candidate directly (cheap, without touching lane)
            if not _prevalidate_socks_candidate(cand["host"]):
                log_event("warn", f"candidate {cand['host']}: pre-validation via direct socks failed")
                return None, ""
            # Swap lane's gost to new exit
            old_host = self.store.snapshot(port).get("server_host") if port in self.store.data else None
            if not _gost_restart_socks(port, cand["host"]):
                log_event("warn", f"candidate {cand['host']}: gost restart failed for port {port}")
                if old_host:
                    _gost_restart_socks(port, old_host)
                return None, ""
            ok, _lat, egress_ip = probe_egress_via_proxy(port)
            if not ok or not egress_ip:
                log_event("warn", f"candidate {cand['host']}: probe via lane :{port} failed")
                if old_host:
                    _gost_restart_socks(port, old_host)
                return None, ""
            if ip_in_blacklist(egress_ip, blacklist):
                log_event("warn", f"candidate {cand['host']} egress {egress_ip} blacklisted")
                if old_host:
                    _gost_restart_socks(port, old_host)
                return None, ""
            return egress_ip, cand["host"]
        # --- WireGuard path ---
        endpoint_ip = resolve_host(cand["host"]) or cand["host"]
        privkey = self._resolve_privkey()
        if not privkey:
            log_event("error", "no WG private key available (WG_PRIVATE_KEY empty)")
            return None, ""
        conf = wg_conf_text(privkey, self.address_cidr, None,
                            cand["pubkey"], endpoint_ip, cand["port"])
        conf_path = f"/etc/wireguard/{ifname}.conf"
        old_conf = None
        try:
            with open(conf_path) as f:
                old_conf = f.read()
        except Exception:
            pass

        # PREPARE: write candidate config and bounce interface INSIDE the netns.
        os.makedirs("/etc/wireguard", exist_ok=True)
        with open(conf_path + ".new", "w") as f:
            f.write(conf)
        os.replace(conf_path + ".new", conf_path)
        netns_exec(netns, ["wg-quick", "down", ifname], timeout=30)  # ignore rc (may be down)
        rc, _, err = netns_exec(netns, ["wg-quick", "up", ifname], timeout=45)
        if rc != 0:
            log_event("warn", f"candidate {cand['host']} up failed: {err[:200]}")
            self._restore_old(netns, ifname, old_conf, conf_path)
            return None, ""

        # VERIFY: handshake, then real egress identity through the tunnel.
        deadline = time.time() + 15
        hs_ok = False
        while time.time() < deadline:
            hs_ok, _ = verify_handshake(netns, ifname)
            if hs_ok:
                break
            time.sleep(2)
        if not hs_ok:
            log_event("warn", f"candidate {cand['host']}: no handshake within 15s")
            self._restore_old(netns, ifname, old_conf, conf_path)
            return None, ""

        ok, _latency, egress_ip = probe_egress(netns)
        if not ok or not egress_ip:
            log_event("warn", f"candidate {cand['host']}: probe failed after handshake")
            self._restore_old(netns, ifname, old_conf, conf_path)
            return None, ""

        # Blacklist check happens AFTER the tunnel is established, on the
        # VERIFIED egress IP (never on server identity).
        if ip_in_blacklist(egress_ip, blacklist):
            log_event("warn", f"candidate {cand['host']} egress {egress_ip} blacklisted")
            self._restore_old(netns, ifname, old_conf, conf_path)
            return None, ""

        return egress_ip, conf

    def _restore_old(self, netns: str, ifname: str, old_conf: Optional[str],
                     conf_path: str) -> None:
        """Best-effort restore of the previous working config after a failed candidate."""
        if LANE_MODE == "socks5":
            return  # handled inline per-candidate
        if old_conf:
            try:
                with open(conf_path + ".old", "w") as f:
                    f.write(old_conf)
                os.replace(conf_path + ".old", conf_path)
            except Exception:
                pass
        netns_exec(netns, ["wg-quick", "down", ifname], timeout=30)
        rc, _, err = netns_exec(netns, ["wg-quick", "up", ifname], timeout=45)
        if rc != 0:
            log_event("warn", f"rollback up failed for {ifname} in {netns}: {err[:200]}")

    def _rollback(self, netns: str, ifname: str, port: str) -> Tuple[int, str, str]:
        if LANE_MODE == "socks5":
            saved = self.store.load_last_good(port)
            if saved and saved.strip():
                ok = _gost_restart_socks(port, saved.strip())
                return (0, "", "") if ok else (1, "", "gost restart failed")
            return (1, "", "no last-good host")
        saved = self.store.load_last_good(port)
        conf_path = f"/etc/wireguard/{ifname}.conf"
        if saved:
            try:
                with open(conf_path + ".rb", "w") as f:
                    f.write(saved)
                os.replace(conf_path + ".rb", conf_path)
            except Exception:
                pass
        netns_exec(netns, ["wg-quick", "down", ifname], timeout=30)
        return netns_exec(netns, ["wg-quick", "up", ifname], timeout=45)

    def _resolve_privkey(self) -> str:
        if self.privkey:
            return self.privkey
        # Fall back to the PrivateKey of the currently installed config.
        try:
            for port, cfg in self.registry.lanes.items():
                with open(f"/etc/wireguard/{cfg['ifname']}.conf") as f:
                    m = re.search(r"^\s*PrivateKey\s*=\s*(\S+)", f.read(), re.M)
                    if m:
                        return m.group(1)
        except Exception:
            pass
        return ""


# ---------------------------------------------------------------------------
# run_cmd executor
# ---------------------------------------------------------------------------

AUDIT_LOG = os.path.join(STATE_DIR, "exec-audit.log")


def audit_log(record: Dict[str, Any]) -> None:
    record["ts"] = now_utc_iso()
    record["principal"] = token_hash()  # hash only — never the token
    try:
        with open(AUDIT_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")
    except Exception:
        pass


def run_cmd(cmd: str, timeout_ms: int) -> ExecResult:
    timeout_s = max(0.1, min(timeout_ms / 1000.0, 120.0))
    argv = ["bash", "-lc", cmd]
    start = time.monotonic()
    proc = subprocess.Popen(
        argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL, start_new_session=True, text=True,
        errors="replace",
    )
    timed_out = False
    try:
        out, err = proc.communicate(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(proc.pid, signal.SIGKILL)  # kill whole process group
        except ProcessLookupError:
            pass
        out, err = proc.communicate()
    duration_ms = int((time.monotonic() - start) * 1000)
    if len(out) > MAX_OUTPUT_BYTES:
        out = out[:MAX_OUTPUT_BYTES] + "\n...[truncated]"
    if len(err) > MAX_OUTPUT_BYTES:
        err = err[:MAX_OUTPUT_BYTES] + "\n...[truncated]"
    res = ExecResult(proc.returncode if not timed_out else 137,
                     out, err, duration_ms, timed_out)
    audit_log({
        "cmd": cmd, "exit_code": res.exit_code,
        "duration_ms": duration_ms, "timed_out": timed_out,
    })
    return res


def cmd_allowed(cmd: str) -> bool:
    if not ALLOWLIST:
        return True
    first = cmd.strip().split(" ", 1)[0].strip()
    # allow paths like /usr/bin/wg too
    base = os.path.basename(first)
    return first in ALLOWLIST or base in ALLOWLIST


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------


def log_event(level: str, message: str) -> None:
    line = json.dumps({"ts": now_utc_iso(), "level": level, "component": "lane-ctl",
                       "msg": message})
    sys.stderr.write(line + "\n")
    sys.stderr.flush()


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------

MANAGER: Optional[LaneManager] = None
STORE: Optional[StateStore] = None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "lane-ctl/1.0"

    # -- helpers ------------------------------------------------------------

    def _send(self, code: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass  # client disconnect must not crash the daemon

    def _authed(self) -> bool:
        auth = self.headers.get("Authorization", "")
        return auth == f"Bearer {LANE_TOKEN}"

    def _read_body(self) -> Optional[Dict[str, Any]]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            return None
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
            return data if isinstance(data, dict) else None
        except Exception:
            return None

    def log_message(self, fmt: str, *args: Any) -> None:  # quiet default logging
        pass

    # -- routing ------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        try:
            if not self._authed():
                self._send(401, {"error": "unauthorized",
                                 "message": "missing or invalid bearer token"})
                return
            path = self.path.split("?")[0]
            query = self.path.split("?")[1] if "?" in self.path else ""
            if path == "/v1/status":
                params = dict(
                    kv.split("=", 1) for kv in query.split("&") if "=" in kv)
                port = params.get("port", "")
                if port == "all":
                    lanes = [MANAGER.status_lane(p) for p in MANAGER.registry.ports()]
                    self._send(200, {"lanes": lanes})
                elif port in MANAGER.registry.lanes:
                    self._send(200, MANAGER.status_lane(port))
                else:
                    self._send(404, {"error": "unknown_lane",
                                     "message": f"no such lane: {port!r}"})
                return
            m = re.fullmatch(r"/v1/rotate/([A-Za-z0-9_-]+)", path)
            if m:
                job = STORE.load_job(m.group(1))
                if not job:
                    self._send(404, {"error": "unknown_job",
                                     "message": f"no such job: {m.group(1)}"})
                    return
                public = {k: job.get(k) for k in
                          ("job_id", "port", "state", "attempts", "assigned_ip", "error")}
                self._send(200, public)
                return
            self._send(404, {"error": "not_found", "message": f"no route: {path}"})
        except Exception:
            log_event("error", "GET handler exception: " + traceback.format_exc()[-400:])
            self._send(500, {"error": "internal_error", "message": "see daemon logs"})

    def do_POST(self) -> None:  # noqa: N802
        try:
            if not self._authed():
                self._send(401, {"error": "unauthorized",
                                 "message": "missing or invalid bearer token"})
                return
            path = self.path.split("?")[0]
            body = self._read_body()
            if body is None:
                self._send(400, {"error": "invalid_body",
                                 "message": "body must be a JSON object ≤64KiB"})
                return

            if path == "/v1/rotate":
                port = str(body.get("port", ""))
                blacklist = body.get("blacklist") or []
                if not isinstance(blacklist, list):
                    self._send(400, {"error": "invalid_blacklist",
                                     "message": "blacklist must be an array"})
                    return
                reason = str(body.get("reason") or "operator_request")[:200]
                code, payload = MANAGER.submit_rotate(port, blacklist, reason)
                self._send(code, payload)
                return

            if path == "/v1/run_cmd":
                cmd = body.get("cmd")
                timeout_ms = int(body.get("timeout_ms") or 5000)
                if not isinstance(cmd, str) or not cmd.strip():
                    self._send(400, {"error": "invalid_command",
                                     "message": "cmd must be a non-empty string"})
                    return
                if not cmd_allowed(cmd):
                    audit_log({"cmd": cmd, "rejected": "allowlist"})
                    self._send(403, {"error": "command_not_allowed",
                                     "message": f"command not in allowlist: {cmd.split()[0]}"})
                    return
                res = run_cmd(cmd, timeout_ms)
                self._send(200, res.to_json())
                return

            self._send(404, {"error": "not_found", "message": f"no route: {path}"})
        except Exception:
            log_event("error", "POST handler exception: " + traceback.format_exc()[-400:])
            self._send(500, {"error": "internal_error", "message": "see daemon logs"})


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main() -> None:
    global MANAGER, STORE
    registry = LaneRegistry(LANES_FILE)
    STORE = StateStore(STATE_DIR, registry.ports())
    STORE.mark_running_jobs_interrupted()
    MANAGER = LaneManager(registry, STORE)

    refresher = threading.Thread(target=MANAGER.background_refresher,
                                 daemon=True, name="refresher")
    refresher.start()

    host, _, port_s = LISTEN_ADDR.rpartition(":")
    host = host or "0.0.0.0"
    httpd = ThreadingHTTPServer((host, int(port_s)), Handler)
    httpd.daemon_threads = True
    log_event("info", f"lane-ctl listening on {LISTEN_ADDR} "
                      f"lanes={registry.ports()} allowlist={ALLOWLIST or 'unrestricted'}")

    def shutdown(signum: int, _frame: Any) -> None:
        log_event("info", f"received signal {signum}, shutting down")
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
