#!/bin/sh
set -eu
if ! printf '%s' "${TAVERN_DOMAIN:-}" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'; then
    echo 'TAVERN_DOMAIN must be a lowercase DNS hostname, without a scheme, port, or path.' >&2
    exit 64
fi
TAVERN_MANAGED_AUTH=${TAVERN_MANAGED_AUTH:-false}
TAVERN_ROLE_POLICY=${TAVERN_ROLE_POLICY:-false}
CALLS_ENABLED=${CALLS_ENABLED:-false}
for flag in "$TAVERN_MANAGED_AUTH" "$TAVERN_ROLE_POLICY" "$CALLS_ENABLED"; do
    case "$flag" in true|false) ;; *) echo 'Tavern feature flags must be true or false.' >&2; exit 64;; esac
done
export TAVERN_MANAGED_AUTH TAVERN_ROLE_POLICY CALLS_ENABLED
envsubst '${TAVERN_DOMAIN} ${TAVERN_MANAGED_AUTH} ${TAVERN_ROLE_POLICY} ${CALLS_ENABLED}' < /etc/nginx/tavern-server.conf.template > /tmp/tavern-server.conf
nginx -t -c /etc/nginx/tavern-nginx.conf
exec nginx -c /etc/nginx/tavern-nginx.conf -g 'daemon off;'
