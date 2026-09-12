FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build
FROM nginxinc/nginx-unprivileged:1.28-alpine AS static
COPY docker/cache-control.conf /etc/nginx/tavern-cache-control.conf
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1

FROM static AS npm
COPY docker/npm/nginx.conf /etc/nginx/tavern-nginx.conf
COPY docker/npm/server.conf.template /etc/nginx/tavern-server.conf.template
COPY docker/npm/headers.conf /etc/nginx/tavern-headers.conf
COPY docker/npm/call-headers.conf /etc/nginx/tavern-call-headers.conf
COPY docker/npm/entrypoint.sh /usr/local/bin/tavern-entrypoint.sh
ENTRYPOINT ["/bin/sh", "/usr/local/bin/tavern-entrypoint.sh"]
