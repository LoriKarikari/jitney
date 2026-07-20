<h1 align="center">Jitney</h1>

<p align="center">
  <strong>Ephemeral GitHub Actions runners on Cloudflare Containers.</strong>
</p>

<p align="center">
  <a href="https://github.com/LoriKarikari/jitney/actions/workflows/test.yml"><img alt="Tests" src="https://github.com/LoriKarikari/jitney/actions/workflows/test.yml/badge.svg"></a>
  <a href="supervisor/go.mod"><img alt="Go version" src="https://img.shields.io/github/go-mod/go-version/LoriKarikari/jitney?filename=supervisor%2Fgo.mod"></a>
  <a href="worker/package.json"><img alt="Node version" src="https://img.shields.io/badge/node-%E2%89%A524-brightgreen"></a>
</p>

Jitney is a self-hosted control plane you deploy on your own Cloudflare
account. When a workflow job with `runs-on: jitney` is queued, it boots a
fresh container, registers it as a just-in-time runner for exactly that job,
and tears everything down when the job finishes. There is no standing fleet,
no idle capacity, and no VM to patch.

```yaml
jobs:
  build:
    runs-on: jitney
    steps:
      - uses: actions/checkout@v4
      - run: echo "running on a throwaway Cloudflare container"
```

## What you get

- **One runner per job.** Every job runs on a fresh container with a
  single-use JIT registration. Runners never see App credentials or webhook
  secrets — only their own JIT config.
- **Survives lost webhooks.** A cron pass discovers jobs that are still
  queued on GitHub and provisions runners for them, so a dropped delivery
  doesn't strand your workflow.
- **Cleans up after itself.** Deadlines reclaim runners that never get
  assigned work and kill jobs that run too long. After a job, GitHub's runner
  inventory returns to zero.
- **Proven workloads.** Node.js, Python, Go, and Java all work through their
  official setup actions
  ([evidence](docs/operations/workload-compatibility.md)).

## What you don't get (yet)

- **Docker inside jobs.** The runner image ships the Docker client but no
  daemon, so `docker build`, service containers, and container actions fail.
- **Public repositories.** Only private repositories are admitted; public
  repos are outside the execution trust boundary.
- **A hosted service.** You deploy your own copy.

## Requirements

- A Cloudflare account with [Workers Paid](https://developers.cloudflare.com/durable-objects/platform/pricing/)
  (Durable Objects and Containers)
- A GitHub account or organization where you can create a GitHub App
- Node.js 24 or newer on macOS or Linux (Intel or ARM64)

## Setup

Deployments created by Jitney 0.2.x must be removed and reinstalled once; the
lifecycle-aware CLI does not adopt them. Follow the
[pre-receipt reinstall steps](docs/operations/reinstall-pre-receipt-deployment.md)
before reusing the old deployment name.

```bash
npx get-jitney deploy
```

The installer signs you into Cloudflare if needed, copies the release-pinned
runner image into your Cloudflare registry, and deploys the Worker. It then
opens GitHub to create and install a preconfigured private GitHub App. Jitney
stores the generated App ID, private key, and webhook secret as Cloudflare
Worker secrets; they are never written to your project.

To own the GitHub App through an organization instead of your personal account:

```bash
npx get-jitney deploy --organization YOUR_ORG
```

Once setup finishes, point a workflow in an installed private repository at
`runs-on: jitney` and push. Install only one Jitney GitHub App on each
repository; two control planes will both try to provision the same queued job.
The webhook arrives, a container boots, and the job picks up in a few seconds.
If the webhook is lost, the five-minute reconciliation cron catches the queued
job instead.

## Configuration

| Setting | Where | Default | Meaning |
| --- | --- | --- | --- |
| `RUNTIME_TIMEOUT_MS` | `wrangler.jsonc` vars | `3600000` | Kill jobs that run longer than this |
| `max_instances` | `wrangler.jsonc` containers | `5` | Concurrent runner containers |
| `instance_type` | `wrangler.jsonc` containers | `standard-2` | Container size (1 vCPU, 6 GiB, 12 GB disk) |

## How it works

An ingress Worker verifies webhook signatures and hands events to a Durable
Object Scheduler, which owns all lifecycle state in SQLite. The Scheduler
mints a JIT runner config scoped to one repository, starts a container, and
enforces two deadlines: one for GitHub to assign work to the runner, one for
the job to finish. The design and vocabulary live in [CONTEXT.md](CONTEXT.md);
live probe records live in [docs/operations/](docs/operations/).

## Development

```bash
task ci          # everything CI runs (Go supervisor + TypeScript worker)
task ts:check    # worker only: types, format, lint, knip, tests
task test:race   # supervisor tests with the race detector
```

The repo has two codebases: `worker/` (TypeScript control plane) and
`supervisor/` (Go process supervisor that owns the runner session inside the
container). Engineering conventions are in
[docs/agents/engineering.md](docs/agents/engineering.md).
