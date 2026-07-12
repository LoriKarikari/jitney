# Jitney

Ephemeral, per-job GitHub Actions runners on Cloudflare Containers.

A GitHub App receives `workflow_job` webhooks, mints just-in-time runner
config, and boots a throwaway Cloudflare Container that runs exactly one job
and exits. No standing fleet, no idle capacity, no servers to manage.

## Status

The control plane is deployed in a maintainer test environment and runs real
jobs end to end. A `runs-on: jitney` job moves from queued to completed on a
fresh container, the runner exits after one job, and GitHub's runner inventory
returns to zero.

Proven so far:

- Automatic webhook-to-completion lifecycle on the live test deployment
- Durable acceptance, replay suppression, admission limits, and relational
  lifecycle state in Durable Object SQLite
- Assignment-based cleanup that follows the runner GitHub actually assigns
- Separate assignment and runtime deadlines that reclaim the Runner Container
- Scheduled recovery of a queued job after its webhook delivery failed
- Node.js, Python, Go, and Java workloads through their official setup
  actions ([evidence](docs/operations/workload-compatibility.md))
- Secret containment in the runner's environment and readable `/proc`
  ([evidence](docs/operations/lifecycle-evidence.md))

Docker workloads do not work yet: the runner image ships the client but no
daemon. Public repositories also remain outside Jitney's execution trust
boundary.

## How it works

```text
GitHub workflow_job webhook
  → Ingress Worker (HMAC verify, normalize, durable accept, 202)
    → Scheduler DO

Cloudflare cron
  → GitHub queued-job discovery
    → Scheduler DO

Scheduler DO (Job Intake, idempotency, admission, deadlines)
  → GitHub JIT config + Runner Container DO
    → one JIT runner, one job, exit
```

Webhook events and reconciled queued jobs converge on the same Scheduler-owned
Job Intake. Reconciliation never invents a Delivery identity for a webhook
that did not arrive. The Scheduler owns all Job and Runner Attempt state in
Durable Object SQLite.
Runner Containers receive only a single-use JIT config; App credentials,
webhook secrets, and installation tokens never enter the data plane. The
domain vocabulary and security model live in [CONTEXT.md](CONTEXT.md).

## Repository layout

| Path | Contents |
| --- | --- |
| `worker/` | TypeScript control plane: ingress, Scheduler lifecycle, provisioning, telemetry |
| `supervisor/` | Go supervisor that owns the runner session and bounded shutdown |
| `runner/` | Runner image: GitHub's `actions-runner` base, tini, supervisor |
| `docs/operations/` | Deployment records and live evidence |
| `docs/research/` | Architecture and platform research |
| `docs/agents/` | Engineering conventions, domain model, issue workflow |

## Development

Prerequisites: Go, Node 24 with pnpm, [Task](https://taskfile.dev), and a
running Docker-compatible engine for image builds and deploys.

```bash
task ci          # run everything CI runs (Go and TypeScript)
task ts:check    # control plane only: types, typecheck, format, lint, knip, tests
task test:race   # supervisor tests with the race detector
```

Deploys go through `wrangler deploy` from `worker/` and require the Docker
engine because Wrangler builds the runner image. Schema changes are made in
`worker/src/schema.ts`, then generated into a migration with
`pnpm exec drizzle-kit generate`.

Engineering conventions are in
[docs/agents/engineering.md](docs/agents/engineering.md).

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
