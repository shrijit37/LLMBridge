# lane-egress container: multi-lane WireGuard egress + control plane.
#
# Topology (per lane): main-netns gost relay :800N -> veth -> netns wgN
#   (in-netns gost http proxy :8888 + wg tunnel = dedicated egress IP)
#
# Build from this directory:
#   docker build -t lane-egress .

FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 wireguard-tools iptables iproute2 curl ca-certificates bash procps \
 && rm -rf /var/lib/apt/lists/*

# gost v2 static binary from the official image. Digest-pinned (resolved
# 2026-09-05; the manifest list ships linux/arm64, verified) so an unpinned
# :latest drift never silently changes the relay behaviour between deploys.
COPY --from=ginuerzh/gost:latest@sha256:2295c686e0fc2c2130b302fd3f711eeff2bebb9809a24f15bc608d48a2071478 /bin/gost /usr/local/bin/gost

COPY lane_ctl.py /opt/lane-egress/lane_ctl.py
COPY entrypoint.sh /opt/lane-egress/entrypoint.sh
RUN chmod +x /opt/lane-egress/entrypoint.sh

# Required runtime flags (documented; set by `docker run`):
#   --cap-add NET_ADMIN --cap-add NET_RAW --device /dev/net/tun
#   --sysctl net.ipv4.ip_forward=1
WORKDIR /opt/lane-egress
ENTRYPOINT ["./entrypoint.sh"]
