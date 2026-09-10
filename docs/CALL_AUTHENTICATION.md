# Diagnosing call authentication

The issuer's internal address is `http://livekit:7880`. Set
`RTC_AUTH_LIVEKIT_URL=http://livekit:7880` in the existing `.env`, or omit that
override to use the same default. Keep the browser-facing Tavern hostname on
HTTPS; the gateway returns `wss://<TAVERN_DOMAIN>/livekit/sfu` to browsers.

The pinned issuer uses one `LIVEKIT_URL` for both its private room-creation
request and its returned connection URL ([upstream implementation](https://github.com/element-hq/lk-jwt-service/blob/v0.6.0/helper.go#L179)).
Earlier Tavern configurations sent room creation through a public path that
blocks administrative RPCs; changing the issuer to its private address then
hit a gateway URL check. The gateway now accepts the stack's exact internal
address, verifies the signed room/device scope, and returns the public signaling
address. Public administrative RPCs remain blocked.

For an existing local Git checkout on `V3`, rebuild the changed images and restart
Synapse so it loads the initializer's OpenID listener configuration:

```sh
git pull --ff-only origin V3
sudo docker compose --profile calls up -d --build --force-recreate init synapse rtc-auth tavern-api tavern-web
```

Keep the existing `.env`, Compose project, volumes and call credentials. The
initializer validates existing call configuration before adding a missing OpenID
listener resource, and retains a before image. A Dockhand deployment should use
the updated `compose.github.yaml`, `TAVERN_GIT_REF=V3`, and rebuild/recreate these
same services. Reopen the call after deployment.

Call failures now identify their stage: `CALL_OPENID_UNAVAILABLE` means the
gateway could not complete its internal Synapse check;
`CALL_ISSUER_OPENID_REJECTED` means the issuer's own public verification failed;
`CALL_SFU_ROOM_CREATION_FAILED` means the issuer could not create the LiveKit room.
These errors include no upstream response text or tokens.

If a call joins and immediately reports a lost connection, check the failed
request's path. A `401` on `/api/matrix/_matrix/client/versions` can come from the
embedded widget's unauthenticated version discovery: its pinned SDK deliberately
omits cookies. Tavern now gives that widget the public Matrix base URL for such
discovery, while OpenID, RTC transports, state and encrypted device operations
continue through its authenticated parent driver. Updating this fix requires
rebuilding/recreating `tavern-web` and reloading the browser; restarting only the
API or issuer does not update the embedded client.

Run the read-only diagnostic from the same Compose directory and environment as the deployed stack:

```sh
sudo docker compose exec -T tavern-api python /app/call_diagnostics.py
```

Include public HTTPS routing and Matrix discovery checks when needed:

```sh
sudo docker compose exec -T tavern-api python /app/call_diagnostics.py --public
```

The API image must contain this script and `CALLS_ENABLED=true`. The command reads the deployment's `Config` and the same two LiveKit credential files used by the API. It creates no account, managed session, database, Matrix event, or SFU room. The only POST is a read-only `ListParticipants` request scoped to a newly generated diagnostic name. No existing room is enumerated. Successful checks exit `0`; any failure exits `1`.

Each output line contains only a fixed stage, pass/fail status, an allowlisted category, and an optional HTTP status. It contains no credentials, tokens, response bodies, candidate addresses, participant identities, member counts, or raw transport errors. It is safe to share these result lines. Do not substitute raw container logs or credential files.

| Stage | Expected result | A failure indicates |
| --- | --- | --- |
| `synapse_openid` | `invalid_token_rejected`, HTTP 401 | A 404 means the internal OpenID endpoint is missing; a connection failure means the API cannot reach Synapse. |
| `issuer_health` | `reachable`, HTTP 200 | The API cannot reach the issuer, or its health endpoint is failing. |
| `sfu_health` | `reachable`, HTTP 200 | The API cannot reach the configured internal LiveKit service. |
| `sfu_credentials` | `credentials_accepted`, HTTP 200 or 404 | `credentials_unavailable` means the credential files/configuration could not be validated; `unauthorized` means the SFU rejected the scoped credential. |
| `public_server_discovery` | `discovery_matches`, HTTP 200 | Public discovery does not point at this deployment's HTTPS authority, or public routing/TLS failed. |
| `public_client_discovery` | `discovery_matches`, HTTP 200 | Client-server discovery does not match this deployment's public origin. |
| `public_openid` | `invalid_token_rejected`, HTTP 401 | The public reverse proxy, OpenID route, or TLS connection failed despite any successful internal check. |

OpenID probes intentionally use an invalid token: rejection proves that the endpoint is reachable, without requesting or disclosing a real user's identity. The pinned SFU validates room-scoped administration before its participant lookup. Its local store returns an empty HTTP 200 for a nonexistent diagnostic room; other supported lookup paths can return HTTP 404 with `not_found`. Both are accepted. Unexpected nonempty data is suppressed and reported as `unexpected_room`.

Requests have four-second timeouts, an eight-KiB response limit, no redirects, no environment proxy or cookies, and normal certificate verification. The command has a twelve-second overall deadline. Public checks contact only the configured public origin; they never follow addresses returned by discovery.

These checks do not exchange a real OpenID token, create a conference, connect a browser, or test TURN/media delivery. If they pass but joining still fails, the remaining issuer-to-SFU URL and gateway token-exchange path must also be checked. A `OPEN_ID_ERROR` displayed by the embedded call client can describe failure of this broader token exchange, including an SFU room-creation failure.
