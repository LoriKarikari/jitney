<h1 align="center">Jitney</h1>

<p align="center">
  <strong>Ephemeral GitHub Actions runners on Cloudflare Containers.</strong>
</p>

<p align="center">
  <a href="https://github.com/LoriKarikari/jitney/actions/workflows/test.yml"><img alt="Tests" src="https://github.com/LoriKarikari/jitney/actions/workflows/test.yml/badge.svg"></a>
  <a href="supervisor/go.mod"><img alt="Go version" src="https://img.shields.io/github/go-mod/go-version/LoriKarikari/jitney?filename=supervisor%2Fgo.mod"></a>
  <a href="worker/package.json"><img alt="Node version" src="https://img.shields.io/badge/node-%E2%89%A524-brightgreen"></a>
</p>

Jitney runs GitHub Actions jobs on containers in your own Cloudflare account.
When a job with `runs-on: jitney` is queued, Jitney starts a fresh container
and registers it as a runner for that one job. When the job ends, the
container goes away. Nothing sits idle between builds.

```yaml
jobs:
  build:
    runs-on: jitney
    steps:
      - uses: actions/checkout@v7
      - run: echo "running on a throwaway Cloudflare container"
```

## What you get

- Every job runs in a new container with a single-use runner registration. The
  runner never sees the GitHub App's credentials or webhook secret.
- Jitney asks GitHub for queued jobs every five minutes, so a lost webhook
  doesn't strand a job. If the webhook that reports a finished job is lost,
  Jitney reads the result from GitHub.
- A finished runner frees its slot within 30 seconds. Runners that never get a
  job stop after five minutes, and jobs stop at the time limit.

## What you don't get (yet)

- Docker doesn't work inside jobs. The image has the Docker client but no
  daemon, so `docker build`, service containers, and container actions fail.
- Jitney only accepts jobs from private repositories.
- There's no hosted version. Jitney runs in your Cloudflare account.

## Requirements

- A Cloudflare account on [Workers Paid](https://developers.cloudflare.com/durable-objects/platform/pricing/),
  which includes Durable Objects and Containers
- A GitHub account or organization where you can create a GitHub App
- Node.js 24 or newer on macOS or Linux, Intel or ARM64

## Setup

```bash
npx get-jitney deploy
```

The CLI opens a browser to sign in to Cloudflare if it needs to. Before it
creates anything, it writes a receipt, a record in your Cloudflare account of
what this deployment owns. Then it copies the runner image and creates the
Worker, container application, and Durable Objects. You don't need Docker.

Next, GitHub opens so you can create and install the App. Its ID, private key,
and webhook secret go straight into Worker secrets. Nothing is saved in your
project. If setup fails, Jitney removes what it created. Pass `--keep-partial`
to keep it for debugging.

To have an organization own the GitHub App instead of your personal account:

```bash
npx get-jitney deploy --organization YOUR_ORG
```

Then add `runs-on: jitney` to a workflow in one of the repositories you
selected and push. A runner usually starts within ten seconds. Jitney won't
take over a repository that another deployment already uses.

To run the CLI without a browser, for example in CI, set
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The token needs edit
access to Workers Scripts, Containers, and Workers KV Storage.

## Manage a deployment

Each command takes the deployment's name. That's the Worker name, `jitney` by
default.

```bash
npx get-jitney list                     # compare receipts with what's live
npx get-jitney@<version> upgrade jitney # move to that CLI version
npx get-jitney rollback jitney          # go back to the version before
npx get-jitney repair jitney            # fix drift from the receipt
npx get-jitney adopt jitney             # record a receipt for an older deployment
npx get-jitney destroy jitney           # remove it all
```

`list` reports missing resources, changed settings, and leftovers no receipt
owns. Add `--json` for a machine-readable report.

`upgrade` waits for running jobs to finish first. If the new version fails its
health check, Jitney switches back to the old one.

`repair` shows its plan and asks before it changes anything. It handles cases
like a lock left behind by an interrupted command. Pass `--yes` to skip the
question.

`destroy` checks afterwards that nothing is left. `--dry-run` shows what it
would remove, and `--now` doesn't wait for running jobs.

## Deployment defaults

| Setting | Default | Meaning |
| --- | --- | --- |
| Job timeout | 1 hour | Jobs that run longer are stopped |
| Maximum instances | 5 | Runner containers at once |
| Instance type | `standard-2` | 1 vCPU, 6 GiB memory, 12 GB disk |

## How it works

A Worker checks each webhook's signature and passes the event to the
Scheduler, a Durable Object that keeps every job's state in SQLite. For each
job the Scheduler creates a runner registration limited to one repository and
starts a container. A runner has five minutes to get a job and an hour to
finish it. Every 30 seconds the Scheduler checks that each runner's container
is still up. A job's result always comes from GitHub, through its webhook or,
when that's lost, by asking.

[CONTEXT.md](CONTEXT.md) explains the design, and
[.agents/operations/](.agents/operations/) has notes from live tests.

## Development

```bash
task ci             # everything CI runs
task ts:check       # format and lint the workspace, then check the Worker
task cli:check      # typecheck, test, and package the CLI
task test:race      # supervisor tests with the race detector
pnpm e2e <check>    # live checks against a deployment, see e2e/README.md
```

| Directory | Contents |
| --- | --- |
| `cli/` | `get-jitney`, the command-line tool |
| `worker/` | The Worker, the Scheduler, and the Durable Object behind each runner |
| `shared/` | The contract between the CLI and the Worker |
| `runner/` | The runner container image |
| `supervisor/` | The Go process that runs the GitHub runner inside the container |
| `e2e/` | Live checks against a test deployment |

Engineering conventions are in [.agents/engineering.md](.agents/engineering.md).
