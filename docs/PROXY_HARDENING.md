# NPM and Cloudflare for Tavern

Start with [Installation](INSTALLATION.md). Keep NPM's upstream **HTTP**,
hostname `tavern-web`, port **8080**, and enable WebSockets. NPM terminates HTTPS
with a certificate covering your actual Tavern hostname. Synapse, PostgreSQL,
the account API and LiveKit management stay on private Docker networks.

## Configure proxy trust before upgrading

`TRUSTED_PROXY_CIDRS` now defaults to empty. An API request carrying
`X-Forwarded-For` from an untrusted immediate peer is rejected. Since Tavern's
gateway adds this header, installations using it must explicitly configure
trust before deploying this update. This protects rate limits and initial
administrator setup from browser-supplied addresses.

On the **Docker host**, these read-only commands show network names, addresses
and subnets without printing container environment values or credentials:

```sh
sudo docker inspect npm --format '{{json .NetworkSettings.Networks}}'
sudo docker inspect tavern-tavern-web-1 --format '{{json .NetworkSettings.Networks}}'
sudo docker network inspect tavern_private tavern_proxy --format '{{.Name}} {{json .IPAM.Config}}'
```

Replace container/network names with those in your existing stack. Inspect the
gateway's address on the private network shared with `tavern-api`, and NPM's
address on the proxy network shared with the gateway. For example, **only if
inspection confirms these dedicated networks**, use:

```dotenv
TRUSTED_PROXY_CIDRS=172.23.0.0/24,172.24.0.0/24
```

Fixed gateway/NPM addresses can instead use `/32` entries (IPv6: `/128`). Dynamic
container addresses change on recreation; use small dedicated actual subnets
or reserve stable addresses in your own deployment. Do not copy example CIDRs
without checking them. Do not trust all of `172.16.0.0/12`, arbitrary LANs, or a
shared network containing applications you do not trust. Membership of a trusted
subnet grants the ability to assert forwarded addresses.

Tavern verifies the immediate peer first, then strips trusted hops from right
to left, stopping at the first untrusted address. NPM must append its observed
client address or replace untrusted incoming forwarding headers; it must never
blindly accept a client's claimed IP. For Cloudflare client-IP restoration,
configure NPM's real-IP trust only for Cloudflare's published ingress ranges
and restrict origin access accordingly. Otherwise the Cloudflare edge remains
the client for rate limiting; do not solve that by trusting arbitrary headers.
See [Cloudflare client IP restoration](https://developers.cloudflare.com/support/troubleshooting/restoring-visitor-ips/restoring-original-visitor-ips/).

Set the confirmed CIDRs in Dockhand's private stack environment or the existing
`.env`, then **recreate** `tavern-api` and `tavern-web`. Restart alone does not
apply changed container environment variables.

### Recover a sign-in blocked after an update

An empty or outdated trust setting can leave the web page and containers healthy
while login fails. Current V3 reports `PROXY_TRUST_REQUIRED` (503) and checks this
connection before showing the password form. Older builds return `INVALID_INPUT`
(400) with “Check the values and trusted proxy configuration”. Other invalid
values can also produce that older message; inspect the running configuration.

On an updated API image, run this from any directory on the Docker host:

```sh
sudo docker exec tavern-tavern-api-1 python /app/proxy_diagnostics.py
```

It prints only canonical trusted networks and the currently resolved gateway
addresses. It does not inspect credentials, modify trust, or verify NPM's full
forwarding chain. On an older image without that script, use:

```sh
sudo docker exec tavern-tavern-api-1 python -c 'import os,socket; print("TRUSTED_PROXY_CIDRS=" + os.getenv("TRUSTED_PROXY_CIDRS", "")); print("Gateway IPs: " + ", ".join(sorted({item[4][0] for item in socket.getaddrinfo("tavern-web", 8080)})))'
```

For immediate recovery, trust the verified gateway address with `/32` (IPv6:
`/128`) in the **active deployment's** environment, and recreate **only
`tavern-api`**. Keep the gateway running so its address remains unchanged. If
Dockhand manages the stack, edit its stack environment and recreate that service
there; an unrelated checkout's `.env` may not control the running stack. Do not
delete volumes or clear browser encryption storage to resolve proxy trust.

This address entry is temporary unless the address is reserved. Before the next
whole-stack recreation, use the inspection commands above to configure the
actual dedicated gateway/NPM subnets or reserve their addresses. Trusting only
the gateway can restore login while all users share the NPM address for IP rate
limiting. Correct NPM trust and forwarding are needed to distinguish clients;
account-based login limits continue to apply in either case.

For a Compose-managed installation, once its real deployment directory and
Compose file are confirmed, apply an environment-only API change with:

```sh
sudo docker compose up -d --no-deps --force-recreate tavern-api
```

Use the same `-f`/`--env-file` options as its original deployment when applicable.
That command does not rebuild the API image. To install the new diagnostics and
welcome-screen behavior, follow the normal V3 build/update procedure after
configuring trust that survives recreation. A successful DNS diagnostic does
not replace testing sign-in through the public hostname.

## Cloudflare rules that preserve messaging and calls

Use **Full (strict)** TLS with a valid origin certificate. Keep the TURN hostname
DNS-only. Cloudflare HTTPS proxying does not replace the required inbound media
firewall rules. See [Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/).

If you intentionally restrict countries, scope the rule to the Tavern hostname
and use `not ip.src.country in {"US" "CA"}`. Never use
`country != US OR country != CA`: that condition is true for every country.
Country restrictions can also block legitimate travelers or service requests.
See [Cloudflare's country-set example](https://developers.cloudflare.com/waf/custom-rules/use-cases/allow-traffic-from-specific-countries/).

Match actual administrator routes by exact path or a slash-delimited prefix:

```text
(http.host eq "tavern.hans-homelab.com" and
 (http.request.uri.path eq "/admin" or
  starts_with(http.request.uri.path, "/admin/") or
  http.request.uri.path eq "/api/admin" or
  starts_with(http.request.uri.path, "/api/admin/")))
```

This is a **match expression**, not a mandatory block rule. Apply only the access
restriction you intend; administrative API requests cannot answer HTML challenge
pages. Do not match `URI path contains "/admin"`: it also catches assets such as
`/assets/admin-integrations-AbCd1234.js` and breaks the SPA. Names containing
`admin` have no special permission meaning in Tavern's asset routing.
See [Cloudflare prefix functions](https://developers.cloudflare.com/ruleset-engine/rules-language/functions/#starts_with).

Do not block normal `PUT`, `DELETE` or `PATCH` requests without understanding the
affected API. Do not serve bot/interactive challenge pages on `/api/*`,
`/api/matrix/*`, `/_matrix/*`, `/livekit/*` or `/assets/*`. Matrix long-poll sync,
uploads and LiveKit signaling require their protocol responses. Review any
existing managed/bot rules that challenge these paths. Turnstile is suitable
only for human authentication flows **after** a dedicated server-side integration;
Tavern does not currently provide one.

Do not cache API, auth/session, HTML or `/tavern-config.json` responses. Respect
origin `Cache-Control`: only successful hashed `/assets/*` responses are immutable;
service workers revalidate. Remove any Cache Everything/Edge TTL override that
ignores those headers. See [Cloudflare cache defaults](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/).
