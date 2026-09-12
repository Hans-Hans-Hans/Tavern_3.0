# Browser TURN diagnostics

Open **Admin > Diagnostics > Test TURN allocation**. The test uses the current
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
Later Linux checks passed allocation through that path. Checkpoint `a5efbee`
progressed through allocation and invalid-credential rejection, then failed at
relay byte exchange. Complete relay acceptance remains open; this workspace has
no Docker daemon.

The fixture also pulls the image quietly: verbose
pull progress can exhaust its bounded child-process output buffer before startup.
Failures report only a fixed stage and reason, optional container state/exit/OOM
status, and fixed browser outcome/capture/close counts. They expose no command,
credential, candidate address or raw browser/container error. Success is printed
only after allocation, invalid-credential rejection, bidirectional relay bytes
and all owned cleanup finish.
An inspection failure alone does not count as successful cleanup: a bounded
native inventory must confirm absence, or cleanup remains a failure.
Every successful run must pass both real authentication cases and the relay
exchange before the production traffic-helper phase.

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
Coturn 4.17.2 [rewrites a public peer address to its private mapping](https://github.com/coturn/coturn/blob/4.17.2/src/client/ns_turn_msg.c#L1648)
before [checking the CreatePermission peer ACL](https://github.com/coturn/coturn/blob/4.17.2/src/server/ns_turn_server.c#L3166).
The bare `external-ip=PUBLIC_IP` form establishes mappings but does not add the
private relay address to the allowlist. The explicit public/private form does.
See the pinned [mapping setup and option parser](https://github.com/coturn/coturn/blob/4.17.2/src/apps/relay/mainrelay.c#L2280).
Synapse's [coturn instructions](https://element-hq.github.io/synapse/latest/setup/turn/coturn.html)
therefore exempt the TURN server's own listening address from private-peer denial.

The generated configuration has `listening-ip=0.0.0.0` and no explicit relay IP.
Pinned coturn [copies that listener into its relay list](https://github.com/coturn/coturn/blob/4.17.2/src/apps/relay/mainrelay.c#L3640),
then [maps the bare public IP back to that wildcard](https://github.com/coturn/coturn/blob/4.17.2/src/apps/relay/mainrelay.c#L3669).
Adding the private address to the ACL alone therefore leaves an unusable peer mapping.

The Compose coturn entrypoint derives and validates its one current container
IPv4 address, then adds both `--relay-ip=THAT_ADDRESS` and
`--allowed-peer-ip=THAT_ADDRESS` when starting the existing binary. The original readonly configuration, shared secret, external
mapping and private-subnet blocks remain intact. This also applies to existing
generated configurations after recreating coturn with the updated Compose file;
configuration regeneration is unnecessary. Multiple, malformed, loopback or
non-unicast addresses fail startup with a fixed error. No private subnet is
allowed and `allow-loopback-peers` is not enabled. Coturn appends explicit relay
addresses; hand-written relay lists or public/private mappings require operator
review and are not rewritten by this generated-configuration repair.

Three actual POSIX-shell regressions verify address validation, failure handling
and argument preservation. The enhanced Docker byte-exchange phase failed in the `a5efbee` Linux run.
That result does not confirm the full repair, despite successful allocation.
Subsequent Linux runs at `3da60f6`, `0e11b82` and `051fea8` passed real coturn allocation, invalid-credential rejection, bidirectional relay-only byte exchange, cleanup, and the production browser traffic helper after the explicit relay binding fix. This Windows workspace has no Docker daemon.
Failed relay exchanges now retain only fixed progress stages, bounded candidate
counts and ICE/data-channel state enums, including the state before cleanup.
They continue to require both actual nonce deliveries and both selected relay pairs.


## Optional browser relay traffic test

**Test TURN relay traffic** in Admin Diagnostics uses the same freshly verified
administrator session and short-lived native TURN credentials. Two temporary
relay-only peers exchange random data in both directions; success also requires
both peers to report a selected pair whose local and remote candidates are TURN
relays. Missing route statistics are reported as unavailable, even when data
was exchanged. Microphones, cameras and screen capture are never requested.

This tests this browser's bidirectional path through its configured TURN service.
It does not test microphone capture, audio playback, media codecs or another
participant's network. Candidate protocol describes the relay candidate, not
necessarily the connection from the browser to TURN. The overall 15-second
limit includes credentials, negotiation, exchange and final administrator
verification. Cancellation, navigation and account changes close both peers
and their data channels. Credentials, candidate addresses, SDP and random payloads
are not displayed or logged by the diagnostic.

Focused browser tests exercise the actual Admin component and request-only
Matrix SDK with controlled peer boundaries, including omitted statistics,
contradictory routes, cancellation, account changes and final access revocation.
The existing isolated coturn CI fixture now additionally serves and runs the
actual production helper after its independent two-relay byte exchange. Its
production-helper acceptance was not reached in the `a5efbee` Linux run because the independent relay exchange failed first; it passed in the later runs listed above. This proves the isolated relay transport, not deployed microphone-to-speaker audio on two independent networks. Refresh the actual deployed Compose definition and recreate `coturn` to apply its new startup arguments; restarting the old container does not change those arguments.
