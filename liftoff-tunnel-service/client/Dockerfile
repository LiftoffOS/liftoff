# Customer-side tunnel client.
#
# Wraps stock `chisel client` with a tiny shell entrypoint that polls
# platform-backend's customer endpoint for the assigned loopback port + the
# upstream URL the operator typed into the Liftoff dashboard, then exec-s
# chisel with the right reverse-tunnel spec. This is what lets the dashboard
# textbox stay the single user-facing config — the docker command itself is
# fully generic (token, prefix, terminator URL, api URL only).
#
# Published to Docker Hub at liftoffos/tunnel-client; the platform-backend
# deploy snippet pins a specific tag.
#
# Two-stage: pull the static chisel binary out of jpillora's scratch-based
# image (no shell, can't `apk add` there), then run it on alpine which has
# a real shell + jq + wget for the polling wrapper.

FROM jpillora/chisel:1.10.1 AS chisel-binary

FROM alpine:3.20

RUN apk add --no-cache jq wget ca-certificates \
 && update-ca-certificates

COPY --from=chisel-binary /app/bin /usr/local/bin/chisel
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER nobody

ENTRYPOINT ["/entrypoint.sh"]
