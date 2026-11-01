# NPM and Cloudflare for Tavern

## Diagnosis and request path

For managed authentication the path is Cloudflare -> Nginx Proxy Manager ->
`tavern-web:8080` -> Tavern API -> Synapse. The SPA alone loading says nothing
about API proxy trust. `docker/npm/server.conf.template` routes `/api/` (including
`/api/auth/config` and `/api/auth/login`) to the API. `api/server.py`, `Service.ip`,
passes the TCP peer and X-Forwarded-For to `api/security.py`, `client_address`.
An untrusted immediate peer with XFF produces `PROXY_TRUST_REQUIRED` (503).
This specific error is not hostname validation, TLS failure, or a bad password.

In the reported topology, 172.24.0.7 is the API itself; the old API peer was
Web's private address, 172.24.0.3. Trusting the API's own /32 cannot authorize
Web. `TRUSTED_PROXY_CIDRS` in the Web environment had no effect: nginx's
entrypoint does not read it. Only the account API consumes this setting.
Synapse has its own generated x_forwarded setting; it is not controlled by this
variable. Raw managed login endpoints are blocked at Web to prevent bypasses.

## Persistent trust boundary

The canonical compose.yaml and all four generated GitHub/Dockhand variants now
create internal `api_gateway`, with only Web and API attached. Web is reserved at
172.30.240.2 on 172.30.240.0/29; dynamic allocation is confined to 172.30.240.4/30
so API startup cannot take Web's reserved address. The API trusts exactly Web's
/32. Web uses the network-scoped `tavern-auth-api` DNS alias, so its connection
cannot randomly use their other shared private network. Diagnostics resolve
`tavern-auth-gateway` on this same network. API addresses may change freely.
Existing private, proxy, egress and media connectivity is retained; no API port
is published. Do not attach unrelated services to api_gateway or reuse its aliases.

Before deploying check for overlap with Docker networks, LAN/VPN and host routes:

```sh
sudo docker network ls -q | xargs -r sudo docker network inspect --format '{{.Name}} {{json .IPAM.Config}}'
ip route
```

If needed set all three together in the active stack environment:

```dotenv
TAVERN_GATEWAY_SUBNET=172.30.240.0/29
TAVERN_GATEWAY_POOL=172.30.240.4/30
TAVERN_GATEWAY_IP=172.30.240.2
TRUSTED_PROXY_CIDRS=
```

Use an unused subnet, a dynamic pool inside it, and a usable Web address outside
that pool. These are infrastructure defaults, not observations of your host.
Do not alter existing network IPAM in place: Docker requires recreating that
network if these values later change, during a maintenance window.

`TRUSTED_PROXY_CIDRS` in the stack environment now means **additional trusted
hops**; Compose prepends the reserved Web /32 to the API environment. Remove the
old `172.24.0.7/32` value. Empty additional trust restores login securely: the
API stops at the observed NPM address and all users share that IP rate limit.
Account limits still apply. No public ranges or whole private networks are needed.

For individual client IPs, optionally reserve NPM's address in **NPM's own
Git-managed Compose configuration**, outside that network's dynamic allocation
pool, and add only its /32 here. For example `172.23.0.3/32` is valid only after
confirming ownership, subnet and reservation; its current observed address alone
is not a durable reservation. NPM may otherwise restart/recreate with any address
without breaking authentication, but individual IP attribution will stop at NPM.
Trusting a shared subnet grants every container in it permission to assert IPs.

The API strips trusted hops right to left and stops at the first untrusted IP.
Web appends its observed peer for /api/ requests. NPM must overwrite incoming XFF
with its verified client address or append its actual peer; forwarding an
unverified browser chain unchanged is unsafe when NPM is trusted. X-Real-IP,
Forwarded, X-Forwarded-Host and X-Forwarded-Proto are not API identity inputs.

The API requires an HTTPS TAVERN_PUBLIC_URL and uses that fixed origin for CSRF
and generated links. Cookies are __Host-, Secure, HttpOnly, SameSite=Strict,
Path=/, without Domain. Web sets upstream Host to TAVERN_DOMAIN and protocol to
https; it does not infer these from browser headers. This configuration requires
HTTPS at the public edge and HTTPS redirects at NPM; direct HTTP to Web must
remain internal. The SFU WebSocket location explicitly forwards Upgrade and
Connection and authorizes the handshake through the API.

## NPM and Cloudflare changes outside this repository

In NPM select the exact domain `tavern.hans-homelab.com`, upstream scheme HTTP,
hostname tavern-web, port 8080, Websockets Support enabled, and Force SSL. Attach
NPM to the existing tavern_proxy network. Keep API, Synapse, database and raw
RTC services unpublished. Retain the loopback-only host binding for Web.

Inspect the generated NPM configuration, rather than assuming UI defaults:

```sh
sudo docker inspect npm --format '{{json .NetworkSettings.Networks}}'
sudo docker exec npm nginx -T
```

Replace `npm` with the actual container name. Inspect locally; nginx -T can
contain unrelated hostnames and configuration. Verify this host's proxy location
sets Host correctly, preserves upgrades and sends XFF as `$remote_addr` (replace)
or `$proxy_add_x_forwarded_for` (append observed peer). Avoid duplicate header
directives in Advanced configuration; update the effective proxy location.

For Cloudflare visitor restoration, NPM must trust only Cloudflare ingress
ranges with CF-Connecting-IP, and the origin firewall must restrict ingress to
Cloudflare or another authenticated path. Keep those ranges current. Without
that setup the Cloudflare edge is the effective client; do not blindly trust
CF-Connecting-IP or arbitrary forwarded headers. See Cloudflare's official
[visitor IP documentation](https://developers.cloudflare.com/support/troubleshooting/restoring-visitor-ips/restoring-original-visitor-ips/).

Use Cloudflare Full (strict) and an NPM certificate whose SAN covers
`tavern.hans-homelab.com` (an explicit SAN or `*.hans-homelab.com`).
`*.tavern.hans-homelab.com` does **not** cover that hostname. The reported public
200 and valid edge certificate do not verify NPM's separate origin certificate.
Check with SNI against the actual NPM IP, not Cloudflare's public DNS address:

```sh
openssl s_client -connect NPM_IP:443 -servername tavern.hans-homelab.com -verify_hostname tavern.hans-homelab.com -verify_return_error </dev/null
curl --resolve tavern.hans-homelab.com:443:NPM_IP -I https://tavern.hans-homelab.com/
```

Replace NPM_IP with its reachable origin address. For a Cloudflare Origin CA
certificate supply the appropriate CA to openssl/curl; do not disable validation.
See [Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)
and [nginx header behavior](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header).

## Dockhand redeployment and verification

Nothing in this change automatically commits, pushes, deploys, or edits NPM.

1. Review and test the patch, then explicitly approve committing/pushing it to
   the ref tracked by the existing Dockhand stack (currently V3). A local edit
   cannot appear in Dockhand until published to its configured Git source.
2. Preserve the existing project name, volume mappings, secrets, domain and
   profiles. In Dockhand's stack environment clear the old TRUSTED_PROXY_CIDRS;
   set the three network values above only after checking for overlap.
3. Keep the existing Compose filename. Synchronize Git and inspect Dockhand's
   rendered stack for api_gateway, Web's reserved address, and the prepended
   /32 in the API environment. Do not edit Dockhand's read-only Compose view.
4. Rebuild Web and API from this same revision. compose.github*.yaml builds
   from TAVERN_GIT_REF (default V3), which must contain this patch.
   compose.dockhand*.yaml is image-only: build/publish new uniquely tagged Web
   and API images first and set TAVERN_WEB_IMAGE and TAVERN_API_IMAGE to those
   tags/digests. Git synchronization alone does not update image contents.
   Do not pair the new dedicated upstream alias with an old network model.
5. Validate the active Compose configuration and redeploy/recreate Web and API
   together so both gain the dedicated network and Web loads the new template.
   Restart alone does not apply environment/network changes. Keep volumes.
   Other services retain their existing connections and state.

Equivalent commands for a source checkout on the Docker host, **only when that
checkout and environment are the actual deployment**, are:

```sh
sudo docker compose -f compose.yaml --env-file .env config --quiet
sudo docker compose -f compose.yaml --env-file .env build tavern-web tavern-api
sudo docker compose -f compose.yaml --env-file .env up -d --no-deps --force-recreate tavern-api tavern-web
sudo docker compose -f compose.yaml --env-file .env ps
sudo docker compose -f compose.yaml --env-file .env exec -T tavern-api python /app/proxy_diagnostics.py
sudo docker compose -f compose.yaml --env-file .env exec -T tavern-web nginx -t -c /etc/nginx/tavern-nginx.conf
```

Use the existing deployment's actual -f/--env-file/project options. For image-only
stacks pull the approved new images instead of build. Do not run down -v.
Diagnostics should pass and show only the dedicated Web address as gateway.

```sh
curl -fsS https://tavern.hans-homelab.com/api/auth/config
curl -fsS https://tavern.hans-homelab.com/health/ready
curl -fsS https://tavern.hans-homelab.com/api/auth/config -H 'X-Forwarded-For: 127.0.0.1' -H 'X-Forwarded-Proto: http' -H 'X-Forwarded-Host: evil.example'
```

Expect no signInError in auth/config, including the spoofing probe. That probe
checks admission only; unit tests verify IP selection. Log in in the browser,
verify Secure/HttpOnly/SameSite cookie attributes and successful session refresh,
and check a call's authenticated WebSocket upgrade if calls are enabled. Do not
paste credentials or cookies into terminal logs. Repeat these checks after a
normal Web/API recreation; repeat after NPM recreation to verify optional IP
attribution if a reserved NPM address is used.

If sign-in still fails, run diagnostics, inspect network memberships and
`docker compose logs --tail=100 tavern-web tavern-api` locally. Diagnostics
checks DNS and configured trust, not an observed live peer or NPM's headers.
PROXY_TRUST_REQUIRED means the observed peer is outside trust; INVALID_PROXY_CHAIN
means malformed XFF from a trusted hop; CSRF_REJECTED means Origin differs from
TAVERN_PUBLIC_URL. TLS hostname errors require fixing the certificate. Do not
clear browser encryption storage or delete volumes to fix any of these.

For emergency recovery on the **old** topology before applying this patch,
verify Web still owns 172.24.0.3 on tavern_private, temporarily trust only
172.24.0.3/32 in the API environment, and recreate only API while Web stays
running. This temporary setting is not durable and groups rate limits at NPM.
Use the dedicated-network migration for the persistent fix.

## Patch validation

The final focused run passed 33 tests covering proxy primitives, dedicated
topology, diagnostics, Compose structure/provisioning, trusted and untrusted
login, spoofed headers, fixed HTTPS origin, secure cookies and CSRF. Run with:

```sh
python -m unittest tests.test_proxy_topology tests.test_proxy_diagnostics tests.test_api_security tests.test_compose_provision tests.test_api.AccountAPITests.test_proxy_trust_failure_is_detected_before_passwords_and_recovers tests.test_api.AccountAPITests.test_malformed_forwarded_chain_cannot_mint_a_login_session tests.test_api.AccountAPITests.test_proxy_headers_cannot_override_public_https_origin_or_cookie tests.test_api.AccountAPITests.test_cookie_session_hides_tokens_and_csrf_rejects_cross_site
python scripts/sync-compose-aliases.py --check
```

The earlier broader run executed 58 tests: 55 passed, 2 nginx-dependent tests
were skipped, and the existing storage inventory test failed because its
response includes the filename secrets.key. That failure also reproduced using
the original test from HEAD; the inventory implementation is unchanged here.
The final focused run additionally includes the new HTTPS configuration test.
No Docker or nginx executable was available on this workstation, so live
network routing, recreation, WebSocket upgrades, actual Compose engine
validation and production certificates remain host-side verification steps.
The reserved-address and trust-chain tests simulate topology; they do not claim
to replace those live checks. The disposable Docker CI fixtures were updated for
the new DNS alias/network, with a separate subnet for concurrent rollback tests.
