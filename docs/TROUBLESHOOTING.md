# Troubleshooting the current stack

Start with [Installation](INSTALLATION.md), then test the failing layer.

| Symptom | Next check |
|---|---|
| API rejects forwarded requests after upgrade | Set actual gateway/NPM CIDRs using [proxy trust](PROXY_HARDENING.md), then recreate API/web. |
| Operations exits immediately | Review the host-root warning and explicit opt-in in [Operations](OPERATIONS.md). |
| API exits with `SMTP_PASSWORD_FILE` error | Verify the mounted path and API UID/group read access; no fallback occurs for an explicitly unreadable file. |
| Call service cannot read a key file | Run current init and recreate API, LiveKit and rtc-auth together; retain credentials. |
| NPM 502 with upstream SSL error | Its upstream must be `http://tavern-web:8080`. |
| Cloudflare 522 while LAN works | Check origin DNS, inbound allow rules, TCP 443 forwarding and NPM listener. |
| UI works but calls lose media externally | Check inbound allow rules for every [call port](CALLS.md), not only NAT forwards. |
| A JS chunk receives a challenge page | Review WAF rules: asset names containing `admin` are ordinary files. |
| HTML/runtime config looks stale | Remove Cloudflare cache overrides; reload without deleting browser encryption storage. |

Run commands in the actual deployment checkout, with the same Compose file,
environment and project that created the running stack:

```sh
sudo docker compose ps
sudo docker compose logs --tail=100 init tavern-api tavern-web synapse
sudo docker exec npm curl --fail http://tavern-web:8080/health
sudo docker compose exec -T tavern-api python /app/call_diagnostics.py --public
```

The diagnostic command omits credentials. Do not paste full container environment
inspection, cookies, recovery keys, successful JWT responses or token-bearing
URLs. The obsolete helper deliberately exits nonzero without writing files;
switch to the root Compose initializer instead of trying to repair that helper.

Dockhand manages its own Git checkout. An unrelated `~/tavern` folder cannot
update it; follow [source selection](DEPLOY_GITHUB.md#choose-the-source-and-compose-file).
