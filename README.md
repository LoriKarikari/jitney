# Jitney

Ephemeral, per-job GitHub Actions runners on Cloudflare Containers.

A GitHub App receives `workflow_job` webhooks, mints just-in-time runner
config, and boots a throwaway Cloudflare Container that runs exactly one job
and exits. No standing fleet, no idle capacity, no servers to manage.

## Status

Architecture and research phase complete. The native end-to-end spike PRD is
ready for implementation at [docs/prd-native-spike.md](docs/prd-native-spike.md).

## Research

- [Architecture review](docs/research/architecture-review.md) — the corrected
  v1 control-plane design: ingress Worker, global Scheduler Durable Object,
  runner Container DOs, and reconciliation.
- [Cloudflare Containers constraints and pricing](docs/research/cloudflare-containers-constraints.md)
  — instance types, limits, billing model, and cost comparison.
- [Runner image internals](docs/research/runner-image-internals.md) — PID 1,
  signal handling, cold-start anatomy, filesystem, and rootless DinD.
- [Podman on Cloudflare Containers](docs/research/podman-on-cloudflare-containers.md)
  — whether rootless Podman can replace rootless Docker for the runner image.
- [gh-runner-broker lessons](docs/research/gh-runner-broker-lessons.md) — prior
  art findings, with superseded items marked.
