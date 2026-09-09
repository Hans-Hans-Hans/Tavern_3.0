# Requires BuildKit with Dockerfile ADD --checksum support (v1.6 or newer).
# This opt-in prototype is not referenced by Tavern Compose or release workflows.
FROM --platform=$BUILDPLATFORM golang:1.26.6-alpine3.24@sha256:af8d6740070b8906d12eae1c3e3ea0957fb63f492051ea05e354c38ef9fe88df AS source
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
WORKDIR /workspace

ADD --checksum=sha256:e737e746e8f2f8d9ca7f23cbebf4b6e50526b6088831f86f0ef2e1c5a6b2ffd5 https://codeload.github.com/livekit/livekit/tar.gz/3cfbd1242618a61178f7a05b126d6c0c4cac3731 /tmp/livekit.tar.gz
ADD --checksum=sha256:1c31abc85e6e8de32d940fdd16c9d78cad42618e0281f5928e4201b7369590d6 https://codeload.github.com/livekit/protocol/tar.gz/17c16cf496fd20697ff862daf9768f9830ebe6fd /tmp/protocol.tar.gz
COPY livekit-audio.patch protocol-audio.patch patches.sha256 patched-files.sha256 provenance.json /build/
COPY apply.go apply_test.go /build/
COPY licenses/ /licenses/
COPY NOTICE /licenses/TAVERN-NOTICE
RUN cd /build && sha256sum -c patches.sha256 && go test apply.go apply_test.go
RUN mkdir livekit protocol \
    && tar -xzf /tmp/livekit.tar.gz -C livekit --strip-components=1 \
    && tar -xzf /tmp/protocol.tar.gz -C protocol --strip-components=1 \
    && go run /build/apply.go /workspace/protocol /build/protocol-audio.patch \
    && go run /build/apply.go /workspace/livekit /build/livekit-audio.patch \
    && cd /workspace && sha256sum -c /build/patched-files.sha256
# go.sum remains authoritative; never use an unconstrained generator/bootstrap.
RUN go -C protocol mod download && go -C livekit mod download

FROM source AS verified
# Real loopback RPC/Pion/RTP tests use no Docker socket, Matrix account, Redis,
# STUN server or external media connection. Do not run upstream multinode tests.
RUN go -C protocol test -mod=readonly ./auth -count=1 \
    && go -C livekit test -mod=readonly ./pkg/rtc -run '^TestTavern' -count=1 \
    && go -C livekit test -mod=readonly ./test -run '^TestTavernReal' -count=1 -timeout=90s

FROM verified AS build
ARG TARGETOS
ARG TARGETARCH
RUN test "$TARGETOS" = linux \
    && case "$TARGETARCH" in amd64|arm64) ;; *) exit 1 ;; esac \
    && GOOS="$TARGETOS" GOARCH="$TARGETARCH" go -C livekit build \
       -mod=readonly -trimpath -buildvcs=false -o /out/livekit-server ./cmd/server

# The digest is deliberately fixed. Refresh it through review rather than
# silently upgrading packages during a supposedly reproducible build.
FROM alpine:3.24.1@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b AS prototype
LABEL org.opencontainers.image.title="Tavern SFU audio-permission prototype" \
      org.opencontainers.image.licenses="Apache-2.0" \
      io.tavern.livekit.revision="3cfbd1242618a61178f7a05b126d6c0c4cac3731" \
      io.tavern.protocol.revision="17c16cf496fd20697ff862daf9768f9830ebe6fd"
COPY --from=build /out/livekit-server /livekit-server
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=source /licenses/ /usr/share/licenses/tavern-sfu/
COPY --from=source /build/provenance.json /build/patches.sha256 /build/patched-files.sha256 /usr/share/tavern-sfu/
ENTRYPOINT ["/livekit-server"]
