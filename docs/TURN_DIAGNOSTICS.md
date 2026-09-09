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
publishes only an ephemeral loopback TCP listener, uses temporary random HMAC
credentials, bounds relay ports and denies all peer destinations. Real Chromium
runs the production diagnostic helper against it and checks both allocation and
invalid-credential rejection. The container, network, browser and HTTP fixture
are closed afterward. No production account, configuration or volume is used.

That isolated Docker acceptance is pending its first CI execution. It tests
browser/coturn allocation and authentication separately from the managed-account
credential-fetch integration; it is not a media end-to-end test.
