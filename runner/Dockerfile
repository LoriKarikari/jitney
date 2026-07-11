# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM golang:1.26-bookworm AS supervisor-build
ARG TARGETOS=linux
ARG TARGETARCH
WORKDIR /src
COPY supervisor/go.mod ./
COPY supervisor/cmd ./cmd
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags='-s -w' -o /out/jitney-supervisor ./cmd/supervisor

FROM ghcr.io/actions/actions-runner:latest
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
