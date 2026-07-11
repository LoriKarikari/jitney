# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM golang:1.26-bookworm@sha256:18aedc16aa19b3fd7ded7245fc14b109e054d65d22ed53c355c899582bbb2113 AS supervisor-build
ARG TARGETOS=linux
ARG TARGETARCH
WORKDIR /src
COPY supervisor/go.mod ./
COPY supervisor/cmd ./cmd
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags='-s -w' -o /out/jitney-supervisor ./cmd/supervisor

FROM ghcr.io/actions/actions-runner@sha256:08c30b0a7105f64bddfc485d2487a22aa03932a791402393352fdf674bda2c29
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
