<h1 align="center">Jitney</h1>

<p align="center">
  <strong>Ephemeral GitHub Actions runners on Cloudflare Containers.</strong>
</p>

<p align="center">
  <a href="https://github.com/LoriKarikari/jitney/actions/workflows/test.yml"><img alt="Tests" src="https://github.com/LoriKarikari/jitney/actions/workflows/test.yml/badge.svg"></a>
  <a href="supervisor/go.mod"><img alt="Go version" src="https://img.shields.io/github/go-mod/go-version/LoriKarikari/jitney?filename=supervisor%2Fgo.mod"></a>
  <a href="worker/package.json"><img alt="Node version" src="https://img.shields.io/badge/node-%E2%89%A524-brightgreen"></a>
</p>

Jitney runs ephemeral GitHub Actions runners in your own Cloudflare account.
When a job with `runs-on: jitney` enters the queue, Jitney starts a fresh
container and registers it for that job alone. The container disappears when
the job is done, so there is no runner fleet sitting idle between builds.

```yaml
jobs:
  build:
    runs-on: jitney
    steps:
      - uses: actions/checkout@v4
      - run: echo "running on a throwaway Cloudflare container"
```

## What you get

- Each job gets a fresh container and a single-use JIT registration. The runner
  never sees the GitHub App credentials or webhook secret.
- Jitney checks GitHub for queued jobs every five minutes. If a webhook goes
  missing, the workflow still gets a runner.
- Unclaimed runners are removed, and jobs are stopped when they run past their
  deadline. Finished runners disappear from GitHub too.

## What you don't get (yet)

- Docker does not run inside jobs. The image has the Docker client but no
  daemon, so `docker build`, service containers, and container actions fail.
- Jitney currently accepts jobs only from private repositories.
- This is not a hosted service. Jitney runs in your Cloudflare account.

## Requirements

- A Cloudflare account with [Workers Paid](https://developers.cloudflare.com/durable-objects/platform/pricing/)
  (Durable Objects and Containers)
- A GitHub account or organization where you can create a GitHub App
- Node.js 24 or newer on macOS or Linux (Intel or ARM64)

## Setup

```bash
npx get-jitney deploy
```

The installer opens a browser for Cloudflare sign-in when needed. It writes a
deployment receipt before touching your Cloudflare resources, then copies the
runner image and creates the Worker, Container Application, Durable Objects,
and bindings. You do not need Docker or another deployment tool.

GitHub opens next so you can create and install the App. Its ID, private key,
and webhook secret go straight into Cloudflare Worker secrets; nothing is
saved in your project. If setup fails, Jitney removes what it created. Use
`--keep-partial` to leave the failed deployment in place instead.

To own the GitHub App through an organization instead of your personal account:

```bash
npx get-jitney deploy --organization YOUR_ORG
```

Once setup finishes, add `runs-on: jitney` to a workflow in one of the private
repositories you selected, then push. Jitney refuses to claim a repository
that already belongs to another deployment. A webhook normally starts the
runner within a few seconds; the five-minute GitHub check catches the job if
that webhook never arrives.

## Deployment defaults

| Setting | Default | Meaning |
| --- | --- | --- |
| Job timeout | 1 hour | Kill jobs that run longer than this |
| Maximum instances | 5 | Concurrent runner containers |
| Instance type | `standard-2` | Container size (1 vCPU, 6 GiB, 12 GB disk) |

## How it works

An ingress Worker verifies webhook signatures and hands events to a Durable
Object Scheduler, which owns all lifecycle state in SQLite. The Scheduler
mints a JIT runner config scoped to one repository, starts a container, and
enforces two deadlines: one for GitHub to assign work to the runner, and one
for the job to finish. See [CONTEXT.md](CONTEXT.md) for the design and
[docs/operations/](docs/operations/) for records from live tests.

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
