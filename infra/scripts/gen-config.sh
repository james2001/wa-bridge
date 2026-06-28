#!/usr/bin/env sh
# Génère infra/livekit/livekit.generated.yaml en injectant l'IP média et les ports.
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# Charge .env si présent
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

START="${LIVEKIT_RTC_PORT_RANGE_START:-50000}"
END="${LIVEKIT_RTC_PORT_RANGE_END:-50019}"
NODE_IP="${LIVEKIT_NODE_IP:-}"

# Auto-détection de l'IP LAN de l'hôte si non fournie
if [ -z "$NODE_IP" ]; then
  NODE_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true)"
  [ -z "$NODE_IP" ] && NODE_IP="127.0.0.1"
fi

sed \
  -e "s|\${LIVEKIT_NODE_IP}|${NODE_IP}|g" \
  -e "s|\${LIVEKIT_RTC_PORT_RANGE_START}|${START}|g" \
  -e "s|\${LIVEKIT_RTC_PORT_RANGE_END}|${END}|g" \
  infra/livekit/livekit.yaml > infra/livekit/livekit.generated.yaml

echo "✅ livekit.generated.yaml — node_ip=${NODE_IP} udp=${START}-${END}"
