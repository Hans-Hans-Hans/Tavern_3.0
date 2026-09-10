# Browser TURN diagnostics

Open **Admin → Diagnostics → Test TURN allocation**. The test uses the current
account's short-lived authenticated homeserver TURN credentials. It creates a
relay-only WebRTC connection with a data channel, gathers a relay candidate and
closes the connection. It does not request microphone, camera or screen access.

The browser result is separate from the server diagnostics table. Obtaining a
relay candidate proves allocation from this browser and network. It does not
prove a complete call, media delivery, firewall traversal from other networks or
every configured TURN transport. The optional protocol is the relay candidate's
protocol; it is not necessarily the transport used between this browser and TURN.

The complete test has a 15-second deadline, including current administrator
verification, credentials and final authority verification. Cancel, navigation,
sign-out or an account/device/client change closes the test peer and data channel.
The result contains only a fixed status and optional protocol. Credentials,
candidate addresses, raw ICE errors and raw SDK errors are not rendered or logged
by the request-only client. An existing live Matrix client's normal credential
refresh remains owned by that client; the diagnostic never stops it.

A directly opened admin page does not start Matrix sync or Rust encryption.
Its diagnostic creates a temporary request-only SDK client for the exact
same-origin authenticated TURN endpoint, then discards it. It stores no new
account session, encryption keys or diagnostic results. Existing Matrix clients
are reused only when their identity still matches the administrator session.

If allocation fails, verify the TURN hostname, short-lived credential setup and
firewall reachability. Repeat from an external network and separately test an
actual call between two networks. See [call setup](DEPLOY_GITHUB.md).

## Observed checks and isolated acceptance

The semantic tests and mounted AdminConsole browser tests cover credential
transport through the real SDK, native browser candidate parsing, admin denial
and revocation, cancellation, expiry, deadline and account/view cleanup. Their
RTC connection boundary is controlled; they do not claim real TURN reachability.

`scripts/smoke-turn-allocation.mjs` is a separate Linux GitHub Actions fixture. It
creates a uniquely owned internal Docker network and pinned coturn container,
publishes no host ports, uses temporary random HMAC credentials, bounds relay
ports and blocks peer destinations except its exact self-address mapping. It verifies the exact newly created
network/container IDs, ownership labels, internal bridge scope, sole membership,
private IPv4 subnet/address and absence of port publishing. The Linux CI host
then connects directly to that verified bridge endpoint. Real Chromium runs the
production diagnostic helper against it and checks both allocation and
invalid-credential rejection. The production Compose entrypoint permits only the
container's own exact IPv4 address through the private-peer block. A second phase exchanges bounded
nonce-tagged data-channel bytes in both directions between two relay-only peers,
and verifies both selected ICE pairs are relay/relay. A documentation-only
advertised address exercises coturn's public-to-private mapping; the network has
no public route and no other container or peer is admitted. The container,
network, browser and HTTP fixture
are closed afterward. No production account, configuration or volume is used.

The first Linux CI execution failed with a generic error. Later stage diagnostics
identified a running TURN container with no Docker published port. Internal
networks skip [Moby's published-port setup](https://github.com/moby/moby/blob/v28.5.1/libnetwork/endpoint.go#L661).
Docker documents [host access to an internal bridge](https://docs.docker.com/engine/network/port-publishing/#gateway-modes),
which the fixture now uses without adding an external container network.
The next Linux run must prove allocation through that path; acceptance remains
unverified locally because this workspace has no Docker daemon.

The fixture also pulls the image quietly: verbose
pull progress can exhaust its bounded child-process output buffer before startup.
Failures report only a fixed stage and reason, optional container state/exit/OOM
status, and fixed browser outcome/capture/close counts. They expose no command,
credential, candidate address or raw browser/container error. Success is printed
only after allocation, invalid-credential rejection, bidirectional relay bytes
and all owned cleanup finish.
An inspection failure alone does not count as successful cleanup: a bounded
native inventory must confirm absence, or cleanup remains a failure.
The next Linux run must still pass both real authentication cases.

The fixture uses Docker's documented [quiet image pull](https://docs.docker.com/reference/cli/docker/image/pull/)
and the pinned image's [direct turnserver binary](https://github.com/coturn/coturn/blob/docker/4.17.2-r0/docker/coturn/debian/Dockerfile),
with its existing listener, allocation and authentication flags checked against
the [coturn 4.17.2 option parser](https://github.com/coturn/coturn/blob/4.17.2/src/apps/relay/mainrelay.c).
Local tests exercise actual bounded child pipes and diagnostic redaction; they
do not substitute for Docker allocation and byte exchange. This fixture tests
browser/coturn transport separately from managed-account credential fetching.
It does not prove a user's public NAT/firewall route or a complete media call.

## Same-server relays and existing deployments

Tavern's direct Matrix calls require TURN. Successful allocation can coexist
with denied peer traffic when both participants use the same coturn instance.
Coturn4.17.2 [rewrites a public peer address to its private mapping](https://github.com/coturn/coturn/blob/4.17.2/src/client/ns_turn_msg.c#L1763)
before [checking the CreatePermission peer ACL](https://github.com/coturn/coturn/blob/4.17.2/src/server/ns_turn_server.c#L3166).
The bare `external-ip=PUBLIC_IP` form establishes mappings but does not add the
private relay address to the allowlist. The explicit public/private form does.
See the pinned [mapping setup and option parser](https://github.com/coturn/coturn/blob/4.17.2/src/apps/relay/mainrelay.c#L2280).
Synapse's [coturn instructions](https://element-hq.github.io/synapse/latest/setup/turn/coturn.html)
therefore exempt the TURN server's own listening address from private-peer denial.

The Compose coturn entrypoint now derives and validates its one current container
IPv4 address, then adds only `--allowed-peer-ip=THAT_ADDRESS` when starting the
existing binary. The original readonly configuration, shared secret, external
mapping and private-subnet blocks remain intact. This also applies to existing
generated configurations after recreating coturn with the updated Compose file;
configuration regeneration is unnecessary. Multiple, malformed, loopback or
non-unicast addresses fail startup with a fixed error. No private subnet is
allowed and `allow-loopback-peers` is not enabled.

Three actual POSIX-shell regressions verify address validation, failure handling
and argument preservation. The enhanced Docker byte-exchange phase requires its
next Linux CI execution; this Windows workspace has no Docker daemon.
