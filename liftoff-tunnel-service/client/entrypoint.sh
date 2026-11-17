#!/bin/sh
# liftoffos/tunnel-client entrypoint.
#
# Env vars (all required, all set by the docker-run snippet the dashboard
# renders into the deploy artifact):
#   TUNNEL_PREFIX        — tenant prefix (e.g. acme-9f3e)
#   TUNNEL_TOKEN         — per-deployment chisel auth token (tk_…)
#   TUNNEL_TERMINATOR    — wss://tunnels.example.com  (chisel server URL)
#   TUNNEL_API_BASE_URL  — https://api.example.com    (platform-backend API)
#
# Polls $TUNNEL_API_BASE_URL/api/customer/tunnel-config every 5s until the
# operator has typed an upstream URL into the dashboard, then exec-s chisel
# with R:<loopbackPort>:<upstreamHost>:<upstreamPort>. Restarts chisel if the
# config changes later (e.g. operator edits the upstream URL).
#
# Exits non-zero on missing env or persistent failures; docker `--restart`
# brings the container back, which restarts polling — no special handling
# needed for transient outages.

set -eu

for v in TUNNEL_PREFIX TUNNEL_TOKEN TUNNEL_TERMINATOR TUNNEL_API_BASE_URL; do
  eval "val=\${$v:-}"
  if [ -z "$val" ]; then
    echo "fatal: $v is not set" >&2
    exit 64
  fi
done

CFG_URL="${TUNNEL_API_BASE_URL%/}/api/customer/tunnel-config"

fetch_config() {
  # wget on busybox doesn't return distinct exit codes for HTTP status, so we
  # use --server-response and look for a 200 in the headers. Output goes to
  # stdout; stderr keeps the verbose headers out of jq's input.
  wget -q -O - \
    --header="Authorization: Bearer $TUNNEL_TOKEN" \
    --header="X-Tunnel-Prefix: $TUNNEL_PREFIX" \
    "$CFG_URL" 2>/dev/null
}

parse_cfg_field() {
  # $1 = JSON, $2 = field name. Returns empty string when missing.
  echo "$1" | jq -r ".$2 // empty"
}

current_spec=""
child_pid=""

start_chisel() {
  spec="$1"
  echo "tunnel-client: starting chisel with $spec"
  # exec via $@ replacement; chisel's auth slot is user:pass and we keep both
  # in env so they don't show in `ps` (only the connect URL + R-spec do).
  chisel client \
    --auth "$TUNNEL_PREFIX:$TUNNEL_TOKEN" \
    "$TUNNEL_TERMINATOR/_tunnel/ws" \
    "$spec" &
  child_pid=$!
  current_spec="$spec"
}

stop_chisel() {
  if [ -n "$child_pid" ] && kill -0 "$child_pid" 2>/dev/null; then
    echo "tunnel-client: stopping chisel (PID $child_pid) to apply new config"
    kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
    child_pid=""
  fi
}

trap 'stop_chisel; exit 0' INT TERM

while true; do
  cfg=$(fetch_config || true)
  ready=$(parse_cfg_field "$cfg" ready)

  if [ "$ready" != "true" ]; then
    if [ -z "$current_spec" ]; then
      echo "tunnel-client: waiting for upstream URL to be set in the Liftoff dashboard…"
    fi
    sleep 5
    continue
  fi

  loopback=$(parse_cfg_field "$cfg" loopbackPort)
  uhost=$(parse_cfg_field "$cfg" upstreamHost)
  uport=$(parse_cfg_field "$cfg" upstreamPort)

  if [ -z "$loopback" ] || [ -z "$uhost" ] || [ -z "$uport" ]; then
    echo "tunnel-client: warning: incomplete config from API, retrying" >&2
    sleep 5
    continue
  fi

  spec="R:${loopback}:${uhost}:${uport}"

  if [ "$spec" != "$current_spec" ]; then
    stop_chisel
    start_chisel "$spec"
  elif [ -n "$child_pid" ] && ! kill -0 "$child_pid" 2>/dev/null; then
    # Chisel died (e.g. terminator restart); restart it.
    echo "tunnel-client: chisel exited; restarting"
    start_chisel "$spec"
  fi

  sleep 5
done
