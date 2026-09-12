# Calls on the canonical stack

Follow [Installation](INSTALLATION.md#voice-video-screen-sharing-and-turn).
Enable `CALLS_ENABLED=true` and include `calls` in `COMPOSE_PROFILES`; retain all
other enabled profiles. For Hans's deployment the DNS-only TURN name is
`turn.tavern.hans-homelab.com`. `PUBLIC_IP` must be the actual public WAN IPv4.

The root Compose initializer creates `livekit_key`, `livekit_secret`,
`livekit.yaml` and `turnserver.conf` in persistent call storage. It preserves
existing credentials. No manual credential copy or legacy call helper is needed.

```text
rtc-auth → http://livekit:7880 → private RoomService/CreateRoom
browser → wss://TAVERN_DOMAIN/livekit/sfu → authenticated signaling
```

Leave `RTC_AUTH_LIVEKIT_URL` unset, or explicitly set `http://livekit:7880`
with no leading whitespace. The gateway validates issuer responses and returns
the public WebSocket URL. Do not forward Twirp or management endpoints through
NPM. Public HTTPS does not need access to those APIs.

Allow **inbound firewall traffic as well as port forwarding** to the Docker
host: TCP/UDP 3478, UDP 49160–49200, TCP 7881 and UDP 7882. TCP 443 reaches NPM.
Retain TURN's internal-network peer restrictions. Test from separate networks;
allocation alone does not establish a working call/media route.

Runtime call files are `root:10002` mode `0640` inside a `0750` directory.
The API, LiveKit and rtc-auth have supplemental group `10002`. Operator sidecars
and TURN's root-readable configuration remain private. Recreate all consumers
when upgrading so they receive the group before using tightened permissions.

For an existing stack, use the [V3 redeploy sequence](V3_HARDENING.md#existing-v3-redeploy).
For failures, start with [Troubleshooting](TROUBLESHOOTING.md) and
[call authentication diagnostics](CALL_AUTHENTICATION.md). Never publish cookies,
successful token responses or WebSocket URLs containing `access_token`.
