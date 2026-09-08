# Tavern security status — 0.3

This source includes meaningful security controls and has not been independently audited or accepted as a production security release. Full Discord/Teams/Slack parity is also not complete. Compilation and focused tests are narrower evidence than a deployed multi-client assessment.

## Encryption and identity

New conversations are private, invite-only, non-federating Matrix rooms with Megolm encryption. Attachments use the official Matrix encryption implementation. Existing unencrypted rooms are labeled; the Work panel accepts encrypted content only. Membership and numeric permissions are enforced by the homeserver.

The security center supports cross-signing, explicit SAS comparison, authenticated recovery keys, encrypted secret storage, backup creation, and restoration. Confirmation is bound to the displayed SAS comparison and waits for protocol completion. Temporary recovery-key byte buffers are cleared after operations; JavaScript strings and browser memory cannot be guaranteed to be securely erased. A settings-panel unmount cannot zero the operation-owned key. Logout waits for active key operations to finish.

Backup creation uses the Matrix POST API and official Rust backup-key generation. It does not call the SDK reset operation that deletes older backup versions. Discovery errors are not treated as “no backup.” An encrypted per-device pending secret survives an uncertain POST so the same device can resume. Concurrent account setup across independent clients is not an atomic Matrix operation. On a conflict, preserve all keys and inspect the existing identity/backup; do not repeatedly reset. Matching backup private keys from authenticated secret storage establish backup trust even when a newly created version has no signature.

Verification and recovery UI now exists, but live cross-client interoperability remains a release gate. Device verification does not imply that every room participant/device is verified. The generic room encryption icon is not an identity assurance. The client does not currently refuse every send to an unverified recipient.

## Calls and integrations

Direct calls use the SDK's MatrixCall implementation and relay-only TURN, with DTLS-SRTP media. MatrixCall retains upstream compatibility with legacy signaling, including plaintext call events in encrypted rooms. Participant verification remains a separate action; Tavern does not claim verified call signaling merely because a room is encrypted. Prefer the MatrixRTC conference path for the modern group media flow. No custom patch disables or replaces SDK encryption.

Group calls use bundled Element Call and MatrixRTC media encryption through a self-hosted LiveKit SFU. A dedicated widget driver restricts room reads/writes, own-device call state, delayed membership cleanup, and encrypted to-device delivery. It does not expose the Matrix access token in the iframe URL. Browser interoperability, media-key rotation, verified participant behavior, and SFU confidentiality must be exercised in live acceptance before assurance claims.

The webhook bot is a trusted plaintext endpoint for incoming provider messages, then an E2EE Matrix sender. It uses a durable nio crypto store, independently verified device fingerprints, a fixed room/user allowlist, serialized sync/send, per-delivery group-key rotation, explicit recipient key-distribution checks, replay tombstones, and an AES-GCM encrypted outbox. It never automatically approves arbitrary devices or joins arbitrary invitations. It has no outbound forwarding. Bot state and all its private keys/tokens must be backed up together; browser Matrix backup does not recover the bot identity. nio's raw validation logging is suppressed to avoid logging event content.

## Browser, proxy, and host boundaries

Device crypto keys persist in IndexedDB. Tab credentials persist in sessionStorage, with a Web Lock for exclusive crypto-store access. A compromised same-origin script, browser profile, host, or delivered application can access these credentials. Closing a tab is not server-side logout. Revocation cannot erase messages copied by recipients.

Room names, membership, timing, some event metadata, preferences, and bookmark IDs remain visible to the homeserver. Exported messages and downloaded recovery keys are user-controlled files. Collaboration history is currently loaded into memory and is not a full encrypted search index or transactional project database.

The NPM gateway uses same-origin APIs, a restrictive CSP, and a separate same-origin-only iframe policy for the bundled call UI. Public admin and general federation routes are blocked. The OpenID userinfo endpoint is an explicit exception needed by RTC authorization. Synapse and Postgres expose no host ports; TURN/SFU media ports are intentionally published. Media services need reachable public networking; ordinary NPM HTTP proxying cannot substitute for it.

Cloudflare DNS-only keeps HTTPS termination on the operator's infrastructure. With Cloudflare proxying, Cloudflare is an HTTPS intermediary for login and application delivery. E2EE does not protect users from maliciously replaced application JavaScript. The gateway records the NPM peer IP rather than trusting arbitrary browser forwarding headers, so account/device logs do not provide accurate end-user IP attribution without an additional trusted-proxy configuration.

Dependencies are pinned at the application level and integration dependencies have a resolution lock. Not all container base images are pinned by digest. No signed image publication, SBOM attestation, full image scan, independent audit, or live penetration test is included.

## Required release acceptance

Exercise independent accounts/devices, SAS mismatch/cancellation, lost/recovered sessions, wrong recovery keys, interrupted setup, concurrent setup, backup restore onto a clean device, tampered media, unauthorized room/role access, encrypted group calls over different networks, recipient departure during bot delivery, crash/restart replay, proxy route isolation, and complete host/database restore. See [the deployment checklist](docs/CALLS_AND_INTEGRATIONS.md).
