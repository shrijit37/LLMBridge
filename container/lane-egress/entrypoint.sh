#!/usr/bin/env bash
#
# entrypoint.sh — bootstrap the multi-lane egress container.
#
# WireGuard mode (default, LANE_MODE=wireguard):
#   netns wgP  <-veth-  main vhP (10.200.i.0/24)
#   in-netns: gost http :8888 + wg<P> tunnel (NordLynx)
#   main: gost tcp relay :P -> 10.200.i.2:8888
#
# SOCKS5 mode (LANE_MODE=socks5):
#   main netns: gost http :P -F socks5://creds@exit:1080  (no netns/WG)
#   Rotation handled by lane_ctl restarting gost with new exit.
#
# Env:
#   LANES=8001,8002,...     lane ports (default 4 lanes)
#   LANE_MODE=wireguard|socks5
#   NORD_TOKEN              NordVPN access token
#   WG_PRIVATE_KEY          optional: reuse existing WG key
#   LANE_TOKEN              control-plane bearer token (required)
#   WG_ADDRESS              lane interface address (default 10.5.0.2/32)

set -euo pipefail

LANES="${LANES:-8001,8002,8003,8004}"
LANE_MODE="${LANE_MODE:-wireguard}"
WG_ADDRESS="${WG_ADDRESS:-10.5.0.2/32}"
NORD_TOKEN="${NORD_TOKEN:-}"
STATE_DIR="${STATE_DIR:-/var/lib/lane-egress}"

log() { echo "[entrypoint] $*"; }
die() { log "FATAL: $*"; exit 1; }

[[ -n "${LANE_TOKEN:-}" ]] || die "LANE_TOKEN required"
command -v gost >/dev/null || die "gost missing"

readarray -t PORTS < <(tr ',' '\n' <<<"$LANES" | tr -d ' ' | grep -v '^$')
N_LANES=${#PORTS[@]}
log "mode=${LANE_MODE} lanes: ${PORTS[*]}"

mkdir -p "$STATE_DIR"

# ---------------------------------------------------------------------------
# Generate lane registry for lane_ctl (both modes)
# ---------------------------------------------------------------------------
gen_lanes_json() {
  mkdir -p /etc/lane-egress
  {
    echo '{'
    echo '  "lanes": {'
    first=1
    for P in "${PORTS[@]}"; do
      (( first )) || echo ','
      first=0
      printf '    "%s": {"netns": "ns%s", "ifname": "wg%s", "gost_proxy_port": 8888}' "$P" "$P" "$P"
    done
    echo ''
    echo '  }'
    echo '}'
  } > /etc/lane-egress/lanes.json 2>/dev/null || {
    mkdir -p /etc/lane-egress
    { echo '{'; echo '  "lanes": {'; first=1
      for P in "${PORTS[@]}"; do
        (( first )) || echo ','
        first=0
        printf '    "%s": {"netns": "ns%s", "ifname": "wg%s", "gost_proxy_port": 8888}' "$P" "$P" "$P"
      done
      echo ''; echo '  }'; echo '}'; } > /etc/lane-egress/lanes.json
  }
}

# ===========================================================================
# SOCKS5 MODE — dedicated exits, no WireGuard
# ===========================================================================
if [[ "$LANE_MODE" == "socks5" ]]; then
  log "mode socks5: fetching SOCKS credentials"
  if [[ -z "${SOCKS_USER:-}" ]]; then
    [[ -n "$NORD_TOKEN" ]] || die "NORD_TOKEN required for socks5 creds"
    CREDS_JSON="$(curl -fsS -m 15 -u "token:$NORD_TOKEN" https://api.nordvpn.com/v1/users/services/credentials)" \
      || die "failed to fetch SOCKS credentials"
    SOCKS_USER="$(echo "$CREDS_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("username",""))')"
    SOCKS_PASS="$(echo "$CREDS_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("password",""))')"
    [[ -n "$SOCKS_USER" ]] || die "SOCKS credentials empty"
    export SOCKS_USER SOCKS_PASS
    # Persist for lane_ctl's ensure_socks_creds fallback (uses NORD_TOKEN too, but cache here)
    echo "$SOCKS_USER" > "$STATE_DIR/socks_user"
    echo "$SOCKS_PASS" > "$STATE_DIR/socks_pass"
    chmod 600 "$STATE_DIR/socks_user" "$STATE_DIR/socks_pass"
  fi
  log "SOCKS creds OK user=${SOCKS_USER:0:4}***"

  gen_lanes_json

  # Fetch distinct SOCKS exits (limit 2x lanes)
  SERVERS_FILE="$STATE_DIR/socks_servers.txt"
  curl -fsS -m 20 "https://api.nordvpn.com/v1/servers?limit=64&filters%5Bservers_technologies%5D%5Bidentifier%5D=socks" \
    | python3 -c 'import sys,json; [print(x.get("hostname") or x.get("ip_address")) for x in json.load(sys.stdin) if x.get("hostname") or x.get("ip_address")]' \
    > "$SERVERS_FILE" || die "failed to fetch SOCKS server list"
  readarray -t SOCK_HOSTS < <(grep -v '^$' "$SERVERS_FILE")
  (( ${#SOCK_HOSTS[@]} >= 1 )) || die "no SOCKS hosts"

  # Pre-validate and assign distinct exits per lane (opencode must accept)
  i=0
  for PORT in "${PORTS[@]}"; do
    CAND=""
    for TRY in "${SOCK_HOSTS[@]}"; do
      # skip already-assigned
      skip=0
      for P in "${PORTS[@]}"; do
        if [[ -f "$STATE_DIR/lane-${P}.exit" && "$(cat "$STATE_DIR/lane-${P}.exit" 2>/dev/null)" == "$TRY" ]]; then skip=1; break; fi
      done
      (( skip )) && continue
      log "lane $PORT: probing $TRY (chat + responses surfaces) ..."
      # Real probes, not /v1/models: a burned exit still returns 200 on the
      # admission-light models endpoint while zen refuses it for the surface
      # (500). A lane must pass EVERY surface we serve — chat (big-pickle) and
      # Responses (muse-spark rides /v1/responses only) — because we don't yet
      # know whether an egress zen accepts for one also serves the other.
      # Bodies are tiny and non-streaming; PROBE_SURFACES gates the Responses leg.
      PROBE_SURFACES="${PROBE_SURFACES:-chat}"
      PROBE_CHAT_URL="${PROBE_CHAT_URL:-https://opencode.ai/zen/v1/chat/completions}"
      PROBE_CHAT_MODEL="${PROBE_CHAT_MODEL:-big-pickle}"
      PROBE_RESP_URL="${PROBE_RESP_URL:-https://opencode.ai/zen/v1/responses}"
      PROBE_RESP_MODEL="${PROBE_RESP_MODEL:-muse-spark-1.3-contributor-free}"
      need_resp=0
      case ",${PROBE_SURFACES}," in
        *,responses,*) need_resp=1 ;;
      esac
      SES="ses_$(head -c 8 /dev/urandom | od -vAn -tx1 | tr -d ' \n')"
      MSG="msg_$(head -c 8 /dev/urandom | od -vAn -tx1 | tr -d ' \n')"
      if curl -fsS -m 25 --socks5-hostname "${SOCKS_USER}:${SOCKS_PASS}@${TRY}:1080" \
           "$PROBE_CHAT_URL" \
           -H 'Authorization: Bearer public' \
           -H 'Content-Type: application/json' \
           -H 'User-Agent: opencode/1.18.27' \
           -H 'x-opencode-client: cli' \
           -H "x-opencode-session: $SES" \
           -H "x-opencode-request: $MSG" \
           -d "{\"model\":\"$PROBE_CHAT_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":16}" \
           >/dev/null 2>&1 \
        && { [[ "$need_resp" == 0 ]] || curl -fsS -m 25 --socks5-hostname "${SOCKS_USER}:${SOCKS_PASS}@${TRY}:1080" \
             "$PROBE_RESP_URL" \
             -H 'Authorization: Bearer public' \
             -H 'Content-Type: application/json' \
             -H 'User-Agent: opencode/1.18.27' \
             -H 'x-opencode-client: cli' \
             -H "x-opencode-session: $SES" \
             -H "x-opencode-request: $MSG" \
             -d "{\"model\":\"$PROBE_RESP_MODEL\",\"input\":[{\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"hi\"}]}],\"max_output_tokens\":16}" \
             >/dev/null 2>&1; }; then
        CAND="$TRY"; break
      fi
      log "lane $PORT: $TRY rejected by opencode probe ($PROBE_SURFACES), trying next"
    done
    if [[ -z "$CAND" ]]; then
      # Fallback: pick round-robin even without pre-validation (let lane_ctl handle rotation)
      CAND="${SOCK_HOSTS[$(( i % ${#SOCK_HOSTS[@]} ))]}"
      log "lane $PORT: no pre-validated exit, seeding $CAND (will rotate on demand)"
    fi
    echo "$CAND" > "$STATE_DIR/lane-${PORT}.exit"
    # Start gost chained to that exit
    pkill -f "gost.*:${PORT}(/| )" 2>/dev/null || true
    # URL-encode creds for gost -F
    UENC="$(python3 -c 'import urllib.parse,os;print(urllib.parse.quote(os.environ["SOCKS_USER"],safe=""))')"
    PENC="$(python3 -c 'import urllib.parse,os;print(urllib.parse.quote(os.environ["SOCKS_PASS"],safe=""))')"
    nohup gost -L "http://:${PORT}" -F "socks5://${UENC}:${PENC}@${CAND}:1080" >/tmp/gost-${PORT}.log 2>&1 &
    log "lane $PORT: gost -> socks5://***@${CAND}:1080"
    # Persist for lane_ctl to know current host
    mkdir -p /var/lib/lane-egress
    echo "$CAND" > "/var/lib/lane-egress/lane-${PORT}.host"
    i=$((i+1))
  done

  sleep 1
  for PORT in "${PORTS[@]}"; do
    if pgrep -f "gost.*:${PORT}(/| )" >/dev/null; then
      log "lane $PORT: gost running"
    else
      log "WARN lane $PORT: gost not running"
    fi
  done
  log "handing off to lane_ctl (socks5) on :9100"
  export LANE_MODE SOCKS_USER SOCKS_PASS
  exec python3 /opt/lane-egress/lane_ctl.py
fi

# ===========================================================================
# WIREGUARD MODE (default)
# ===========================================================================
command -v wg >/dev/null || die "wireguard-tools missing for wireguard mode"

KEY_DIR="$STATE_DIR/wg"
mkdir -p "$KEY_DIR"
if [[ -n "${WG_PRIVATE_KEY:-}" ]]; then
  log "using provided WG_PRIVATE_KEY"
elif [[ -n "$NORD_TOKEN" ]]; then
  # Fresh keypair + registration on EVERY boot. A persisted key from an earlier
  # run (e.g. one saved before a failed registration, or pre-token-rotation) is
  # not in Nord's key store, so handshakes silently never complete on any lane.
  # Re-registering on boot is cheap and makes the key store match reality.
  umask 077
  wg genkey > "$KEY_DIR/privatekey"
  PUB="$(wg pubkey < "$KEY_DIR/privatekey")"
  B64="$(printf 'token:%s' "$NORD_TOKEN" | base64 -w0)"
  CODE="$(curl -fsS -o /dev/null -w '%{http_code}' -m 20 -X POST \
    -H "Authorization: Basic $B64" -d "pubkey=$PUB" \
    https://api.nordvpn.com/v1/users/services/nordlynx/servers/pks)" \
    || die "NordLynx key registration failed (HTTP $CODE)"
  case "$CODE" in 2*) ;; *) die "NordLynx key registration HTTP $CODE";; esac
  WG_PRIVATE_KEY="$(cat "$KEY_DIR/privatekey")"
  log "generated + registered fresh WireGuard keypair"
elif [[ -s "$KEY_DIR/privatekey" ]]; then
  # No token configured: fall back to a persisted key (static/offline config).
  WG_PRIVATE_KEY="$(cat "$KEY_DIR/privatekey")"
  log "reused persisted WireGuard private key (no NORD_TOKEN)"
else
  die "no NORD_TOKEN and no persisted key"
fi
export WG_PRIVATE_KEY

sysctl -w net.ipv4.ip_forward=1 >/dev/null
iptables -t nat -C POSTROUTING -s 10.200.0.0/16 -o eth0 -j MASQUERADE 2>/dev/null ||
  iptables -t nat -A POSTROUTING -s 10.200.0.0/16 -o eth0 -j MASQUERADE
mkdir -p /etc/wireguard "$STATE_DIR"

# /run lives on the container's overlay layer in Docker, so stale netns bind
# targets from an earlier partial boot survive `docker restart` and make every
# later `ip netns add` fail with "File exists". Clear them up front.
rm -rf /run/netns /var/run/netns 2>/dev/null || true
mkdir -p /run/netns

# Boot diagnostics (LANE_DEBUG=1): confirm the container really holds the caps
# and primitives the netns/veth setup needs before we fail confusingly.
if [[ "${LANE_DEBUG:-0}" == "1" ]]; then
  log "CapEff=$(awk '/^CapEff:/{print $2}' /proc/self/status)"
  if unshare -n true 2>/tmp/unshare.err; then log "probe: unshare -n OK"; else log "probe: unshare -n FAILED: $(cat /tmp/unshare.err)"; fi
  if ip link add vhprobe type veth peer name vnprobe 2>/tmp/veth.err; then
    log "probe: veth add OK"; ip link del vhprobe 2>/dev/null || true
  else
    log "probe: veth add FAILED: $(cat /tmp/veth.err)"
  fi
fi

SERVERS_FILE="$STATE_DIR/servers.txt"
curl -fsS -m 25 \
  "https://api.nordvpn.com/v1/servers/recommendations?filters%5Bservers_technologies%5D%5Bidentifier%5D=wireguard_udp&limit=$(( N_LANES * 2 ))" \
| python3 -c '
import sys, socket, json
def wg_pub(srv):
    for t in srv.get("technologies") or []:
        if t.get("identifier") != "wireguard_udp":
            continue
        for m in t.get("metadata") or []:
            if m.get("name") == "public_key":
                return m.get("value") or ""
    return ""
for s in json.load(sys.stdin):
    h = s.get("hostname"); pk = wg_pub(s)
    if not h or not pk: continue
    try: ip = socket.getaddrinfo(h, None, socket.AF_INET)[0][4][0]
    except Exception: continue
    print(f"{ip}|{pk}")
' > "$SERVERS_FILE" || die "failed to fetch NordVPN server candidates"

readarray -t SERVER_LINES < <(grep -v '^$' "$SERVERS_FILE")
(( ${#SERVER_LINES[@]} >= N_LANES )) ||
  log "WARN: only ${#SERVER_LINES[@]} candidates for $N_LANES lanes (will reuse)"

gen_lanes_json

i=0
for PORT in "${PORTS[@]}"; do
  i=$((i+1))
  NS="ns${PORT}"; IF="wg${PORT}"
  VH="vh${PORT}"; VN="vn${PORT}"
  SUB="10.200.${i}"
  log "lane ${PORT}: netns=${NS} ifname=${IF}"

  ip netns add "$NS" || log "WARN: ip netns add $NS failed rc=$?"
  ip link add "$VH" type veth peer name "$VN" || log "WARN: veth add $VH/$VN failed rc=$?"
  ip link set "$VN" netns "$NS" || log "WARN: veth $VN -> $NS failed rc=$?"
  ip addr replace "${SUB}.1/24" dev "$VH" || log "WARN: addr ${SUB}.1 failed rc=$?"
  ip link set "$VH" up || log "WARN: veth $VH up failed rc=$?"
  ip -n "$NS" addr replace "${SUB}.2/24" dev "$VN" || log "WARN: addr ${SUB}.2 failed rc=$?"
  ip -n "$NS" link set "$VN" up || log "WARN: veth $VN up failed rc=$?"
  ip -n "$NS" link set lo up || log "WARN: lo up failed rc=$?"
  ip -n "$NS" route replace default via "${SUB}.1" || log "WARN: default route in $NS failed rc=$?"

  # NOTE: do NOT disable IPv6 in the netns — wg-quick's config includes
  # AllowedIPs ::/0 and its `ip -6 route add` fails with "IPv6 is disabled on
  # nexthop device" (observed), aborting the whole tunnel bring-up.

  mkdir -p "/etc/netns/${NS}"
  echo "nameserver 10.5.0.1" > "/etc/netns/${NS}/resolv.conf"

  CONF="/etc/wireguard/${IF}.conf"
  if [[ ! -s "$CONF" ]]; then
    if [[ ${#SERVER_LINES[@]} -gt 0 ]]; then
      LINE="${SERVER_LINES[$(( (i-1) % ${#SERVER_LINES[@]} ))]}"
      EP_IP="${LINE%%|*}"; SRV_PUB="${LINE##*|}"
      cat > "${CONF}" <<EOF
[Interface]
PrivateKey = ${WG_PRIVATE_KEY}
Address = ${WG_ADDRESS}
[Peer]
PublicKey = ${SRV_PUB}
AllowedIPs = 0.0.0.0/0,::/0
Endpoint = ${EP_IP}:51820
PersistentKeepalive = 25
EOF
      log "lane ${PORT}: seeded endpoint ${EP_IP}:51820"
    else
      log "WARN: no candidates — leaving existing ${IF}.conf untouched"
    fi
  fi

  ip netns exec "$NS" wg-quick down "$IF" >/dev/null 2>&1 || true
  if ! ip netns exec "$NS" wg-quick up "$IF"; then
    log "WARN: wg-quick up failed for ${IF} in ${NS} (lane starts degraded)"
  fi

  ip netns exec "$NS" gost -L "http://:8888" >/dev/null 2>&1 &
  gost -L "tcp://:${PORT}/${SUB}.2:8888" >/dev/null 2>&1 &
done

sleep 1
for PORT in "${PORTS[@]}"; do
  NS="ns${PORT}"; IF="wg${PORT}"
  HS=$(ip netns exec "$NS" wg show "$IF" latest-handshakes 2>/dev/null | awk '{print $2}')
  AGE=$(( $(date +%s) - ${HS:-0} ))
  log "lane ${PORT}: handshake age ${AGE}s"
done

log "handing off to lane_ctl control plane on :9100"
exec python3 /opt/lane-egress/lane_ctl.py
