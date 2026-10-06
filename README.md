<h1 align="center">Jitney</h1>

<p align="center">
  <strong>GitHub Actions runners on Cloudflare Containers, one per job.</strong>
</p>

<p align="center">
  <a href="https://github.com/LoriKarikari/jitney/actions/workflows/test.yml"><img alt="Tests" src="https://github.com/LoriKarikari/jitney/actions/workflows/test.yml/badge.svg"></a>
  <a href="supervisor/go.mod"><img alt="Go version" src="https://img.shields.io/github/go-mod/go-version/LoriKarikari/jitney?filename=supervisor%2Fgo.mod"></a>
  <a href="worker/package.json"><img alt="Node version" src="https://img.shields.io/badge/node-%E2%89%A524-brightgreen"></a>
</p>

Jitney runs your GitHub Actions jobs on containers in your own Cloudflare
account. Point a job at it with `runs-on: jitney`:

```yaml
jobs:
  build:
    runs-on: jitney
    steps:
      - uses: actions/checkout@v7
      - run: echo "running on a throwaway Cloudflare container"
```

When that job is queued, Jitney starts a container, registers it as a runner
for that one job, and throws it away when the job ends. Nothing runs between
builds, so you pay for the minutes your jobs actually use. The next job never
sees what the last one left on disk.

Each runner gets a registration that works once, for one repository. The
GitHub App's private key and webhook secret stay in the Worker and never reach
a runner.

## Limits

Docker doesn't work inside jobs. The image has the Docker client but no
daemon, so `docker build`, service containers, and container actions fail.

Jitney only takes jobs from private repositories. On a public repository,
anyone can open a pull request from a fork and run code on your runners, and
Jitney isn't built to contain that.

## Requirements

You need a Cloudflare account on
[Workers Paid](https://developers.cloudflare.com/durable-objects/platform/pricing/),
which includes Durable Objects and Containers, and a GitHub account or
organization where you can create a GitHub App. The CLI runs on Node.js 24 or
newer, on macOS or Linux.

## Setup

```bash
npx get-jitney deploy
```

The CLI opens a browser to sign in to Cloudflare if it needs to. Before it
creates anything, it writes a receipt: a record in your Cloudflare account of
everything this deployment owns. Every later command works from that receipt.
Then it copies the runner image and creates the Worker, the container
application, and the Durable Objects. You don't need Docker on your machine.

GitHub opens next, so you can create the App and pick the repositories it may
use. The App's credentials go straight into Worker secrets and are never
written to your project. If anything fails along the way, the CLI removes what
it created. Pass `--keep-partial` if you want to look at the wreckage first.

If an organization should own the App instead of your personal account:

```bash
npx get-jitney deploy --organization YOUR_ORG
```

Then push a workflow with `runs-on: jitney` to one of those repositories. A
runner usually starts within ten seconds.

To run the CLI without a browser, for example in CI, set
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The token needs edit
access to Workers Scripts, Containers, and Workers KV Storage.

## Running it

Each command takes the deployment's name, which is the Worker name. That's
`jitney` unless you passed `--name` to `deploy`.

`npx get-jitney list` compares each receipt with what's actually in Cloudflare
and GitHub. It reports missing resources, settings that changed behind its
back, and leftovers that no receipt owns. Add `--json` for scripts.

`npx get-jitney@<version> upgrade jitney` moves a deployment to that CLI
version. It stops taking new jobs, waits for running ones to finish, deploys,
and checks the new version's health. If the check fails, it switches back.
`npx get-jitney rollback jitney` returns to the version you had before.

`npx get-jitney upgrade jitney --budget 40` changes how many vCPUs your
runners may use at once. Every runner counts as one vCPU for now, so that's
the number of jobs that run in parallel. Jobs past the budget wait in
Jitney's queue and start as runners finish, spread evenly across
repositories. `deploy --budget` sets it from the start.

`npx get-jitney repair jitney` is for when something went wrong, such as a
command killed halfway that left the deployment locked. It shows what it would
change and asks first. `--yes` skips the question.

`npx get-jitney adopt jitney` writes a receipt for a deployment made before
receipts existed. It keeps the Worker, the GitHub App, and the job history.

`npx get-jitney destroy jitney` removes the deployment and then checks that
nothing is left. Try `--dry-run` first.

## When things go wrong

GitHub's webhooks are reliable, but not perfectly. Jitney assumes some will
get lost.

Every five minutes it asks GitHub for queued jobs, so a job whose webhook never
arrived still gets a runner. If the webhook that reports a finished job goes
missing, Jitney asks GitHub how the job ended rather than guessing. Every 30
seconds it checks that each runner's container is still up, so a finished
runner gives its slot to the next job right away.

A runner that no job claims within five minutes is removed. A job that runs
past the time limit is stopped.

## Splitting a test suite

A long test suite finishes sooner split across runners. Most test runners can
run one slice of the suite, so a job matrix does the rest:

```yaml
jobs:
  test:
    runs-on: jitney
    strategy:
      matrix:
        shard: [1, 2, 3, 4, 5, 6, 7, 8]
    steps:
      - uses: actions/checkout@v7
      - run: npm ci
      - run: npx vitest run --shard=${{ matrix.shard }}/8
```

Playwright takes the same `--shard=1/8` flag, and Jest has `--shard` too. With
a budget below eight, the extra shards wait in the queue and start as the
first ones finish.

## Defaults

| Setting | Default |
| --- | --- |
| Job time limit | 1 hour |
| Concurrency Budget | 20 vCPUs, so 20 jobs at once |
| Jobs waiting past the budget | Up to 256 |
| Container size | `standard-2`: 1 vCPU, 6 GiB memory, 12 GB disk |

## How it works

A Worker receives GitHub's webhooks, checks their signatures, and hands each
event to the Scheduler. The Scheduler is a Durable Object that keeps every
job's state in SQLite. For each job it creates the one-time runner
registration and starts a container through another Durable Object. Inside
the container, a small Go supervisor takes the registration out of the
environment, so job steps can't read it, then runs GitHub's runner and exits
with it.

[CONTEXT.md](CONTEXT.md) has the full design and its vocabulary.
[.agents/operations/](.agents/operations/) has notes from live tests.

## Development

```bash
task ci             # everything CI runs
task ts:check       # format and lint the workspace, then check the Worker
task cli:check      # typecheck, test, and package the CLI
task test:race      # supervisor tests with the race detector
pnpm e2e <check>    # live checks against a deployment, see e2e/README.md
```

`cli/` is `get-jitney`. `worker/` is the Worker and both Durable Objects.
`shared/` holds the few types and functions the CLI and Worker must agree on.
`runner/` builds the container image, and `supervisor/` is the Go process
inside it. `e2e/` runs live checks against a test deployment.

Engineering conventions are in [.agents/engineering.md](.agents/engineering.md).
