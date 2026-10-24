# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM golang:1.27-bookworm@sha256:69a7b9788769bec032d238959b61854e9ae87f57be9029ec04e9885fabf99195 AS supervisor-build
ARG TARGETOS=linux
ARG TARGETARCH
WORKDIR /src
COPY supervisor/go.mod ./
COPY supervisor/cmd ./cmd
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags='-s -w' -o /out/jitney-supervisor ./cmd/supervisor

# GitHub stops queuing jobs to a runner 30 days after a newer release, and a
# JIT runner never lives long enough to update itself. Keep this current.
FROM ghcr.io/actions/actions-runner:2.338.1@sha256:e275409999c37162649aa050ca573f03eab2eabcb3a1e7fcc47548de6b4f9690
USER root
RUN apt-get update \
    && apt-get install --no-install-recommends -y tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=supervisor-build /out/jitney-supervisor /usr/local/bin/jitney-supervisor
RUN chmod 0755 /usr/local/bin/jitney-supervisor \
    && mkdir -p /home/runner/_work \
    && chown -R runner:runner /home/runner/_work
USER runner
WORKDIR /home/runner
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/jitney-supervisor"]
