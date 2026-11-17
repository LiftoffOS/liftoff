#!/bin/sh
# Fill nginx.conf.template with this deployment's own hostnames, then start nginx.
#
# WHY SUBSTITUTE INSTEAD OF USING AN NGINX VARIABLE. A variable inside proxy_pass
# makes nginx resolve the upstream PER REQUEST, which requires a `resolver`
# directive and puts DNS in the request path. Substituting here keeps every
# upstream a literal that nginx resolves once, at startup, exactly as it did when
# the hostnames were hard-coded.
#
# WHY IT REFUSES TO START. The alternative to a missing value is a config
# containing `proxy_pass https://;` — nginx fails on that anyway, with an error
# that says nothing about which variable was unset. Worse would be a default
# pointing at somebody else's deployment. Name the variable and stop.
set -eu

API_ORIGIN="${API_ORIGIN:-}"
DEVELOPER_PROXY_ORIGIN="${DEVELOPER_PROXY_ORIGIN:-}"

missing=''
[ -n "$API_ORIGIN" ] || missing="$missing API_ORIGIN"
[ -n "$DEVELOPER_PROXY_ORIGIN" ] || missing="$missing DEVELOPER_PROXY_ORIGIN"

if [ -n "$missing" ]; then
  echo "nginx entrypoint: refusing to start — unset:$missing" >&2
  echo "  API_ORIGIN              the backend, e.g. https://api.example.com" >&2
  echo "  DEVELOPER_PROXY_ORIGIN  the developer-proxy service's own URL" >&2
  exit 1
fi

# The websocket origin is the API's, by scheme. Deriving it rather than asking
# for it removes the failure where the two are set to different hosts and only
# the streaming endpoints break.
API_ORIGIN_WS="$(printf '%s' "$API_ORIGIN" | sed -e 's|^https://|wss://|' -e 's|^http://|ws://|')"

sed \
  -e "s|\${API_ORIGIN_WS}|${API_ORIGIN_WS}|g" \
  -e "s|\${API_ORIGIN}|${API_ORIGIN}|g" \
  -e "s|\${DEVELOPER_PROXY_ORIGIN}|${DEVELOPER_PROXY_ORIGIN}|g" \
  /etc/nginx/nginx.conf.template > /etc/nginx/conf.d/default.conf

# API_ORIGIN_WS is substituted before API_ORIGIN on purpose: the shorter name is
# a prefix of the longer one, so the other order would turn ${API_ORIGIN_WS}
# into "<api origin>_WS". Any new variable sharing a prefix needs the same care.
if grep -q '\${' /etc/nginx/conf.d/default.conf; then
  echo "nginx entrypoint: unsubstituted placeholder left in the config:" >&2
  grep -n '\${' /etc/nginx/conf.d/default.conf >&2
  exit 1
fi

exec nginx -g 'daemon off;'
