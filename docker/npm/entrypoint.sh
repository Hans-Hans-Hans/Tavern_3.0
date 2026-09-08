#!/bin/sh
set -eu
if ! printf '%s' "${TAVERN_DOMAIN:-}" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'; then
    echo 'TAVERN_DOMAIN must be a lowercase DNS hostname, without a scheme, port, or path.' >&2
    exit 64
fi
envsubst '${TAVERN_DOMAIN}' < /etc/nginx/tavern-server.conf.template > /tmp/tavern-server.conf
nginx -t -c /etc/nginx/tavern-nginx.conf
exec nginx -c /etc/nginx/tavern-nginx.conf -g 'daemon off;'
