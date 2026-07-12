# Jitney

Ephemeral GitHub Actions runners on Cloudflare Containers.

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
- **A hosted service.** You deploy your own copy. The maintainer's deployment
  is a test environment, not something you can point your repos at.

## Requirements

- A Cloudflare account with [Workers Paid](https://developers.cloudflare.com/durable-objects/platform/pricing/)
  (Durable Objects and Containers)
- A GitHub account or organization where you can create a GitHub App
- Locally: Node 24 with pnpm, and a Docker-compatible engine (Wrangler builds
  the runner image during deploy)

## Setup

### 1. Create a GitHub App

Create a [GitHub App](https://docs.github.com/en/apps/creating-github-apps)
on your account or organization with:

- **Repository permissions:** Actions (read), Administration (read and write)
- **Webhook events:** Workflow job
- **Webhook URL:** `https://jitney.<your-subdomain>.workers.dev/webhooks/github`
  (you can fill this in after the first deploy)
- **Webhook secret:** generate one and keep it for step 3

Generate a private key, then install the App on the private repositories that
should use Jitney runners.

### 2. Deploy the Worker

```bash
git clone https://github.com/LoriKarikari/jitney
cd jitney/worker
pnpm install
pnpm exec wrangler deploy
```

The deploy builds the runner image, pushes it to your Cloudflare account, and
prints your Worker URL.

### 3. Set the secrets

```bash
pnpm exec wrangler secret put GITHUB_APP_ID
pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY   # paste the PEM, PKCS#8
```

GitHub issues PKCS#1 keys; convert before pasting:

```bash
openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem
```

### 4. Run a job

Point a workflow in an installed private repository at `runs-on: jitney` and
push. The webhook arrives, a container boots, and the job picks up in a few
seconds. If the webhook is lost, the five-minute reconciliation cron catches
the queued job instead.

## Configuration

| Setting | Where | Default | Meaning |
| --- | --- | --- | --- |
| `RUNTIME_TIMEOUT_MS` | `wrangler.jsonc` vars | `3600000` | Kill jobs that run longer than this |
| `max_instances` | `wrangler.jsonc` containers | `5` | Concurrent runner containers |
| `instance_type` | `wrangler.jsonc` containers | `standard-2` | Container size (1 vCPU, 6 GiB, 12 GB disk) |

## How it works

```text
GitHub workflow_job webhook ─┐
                             ├─→ Scheduler (Durable Object)
Cloudflare cron discovery ───┘      │ admission, idempotency, deadlines
                                    ↓
                             JIT config + Runner Container
                                    │ one runner, one job
                                    ↓
                                  exit
```

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
