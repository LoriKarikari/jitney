# Jitney v1 architecture review

Review completed 2026-07-11 after flare-runner surfaced. This is the design
record that introduced the durable Scheduler; [CONTEXT.md](../../CONTEXT.md)
is authoritative where the deployed design has since become more precise.

## Verdict

Keep the product premise: a GitHub App provisions ephemeral, one-job runners on Cloudflare Containers. Replace the stateless webhook-to-container path with a durable scheduler. The old path had no safe answer for duplicate deliveries, missed deliveries, capacity limits, cross-assignment, or cancellation races.

## Architecture

### Ingress Worker

The webhook handler has one narrow job: verify the raw-body HMAC, validate and normalize the event, submit it durably, and return `202` within GitHub's ten-second deadline. It does not call GitHub or start a container inline.

GitHub does not automatically retry failed webhook deliveries. Operators can manually redeliver them, so duplicate handling is still mandatory. The deployed scheduled reconciler discovers queued jobs through GitHub's installation, repository, workflow-run, and workflow-job APIs. It submits them without fabricating Delivery identity.

### Scheduler Durable Object

V1 uses one global Scheduler Durable Object. Its Job Intake interface accepts Delivery-backed Workflow Events through `accept()` and discovered queued Jobs through `reconcile()`. Its implementation owns:

- delivery and event idempotency;
- terminal-state dominance;
- the pending queue and fair draining across installations;
- global and per-installation admission control;
- runner attempts and retries;
- job-to-runner assignment;
- assignment and runtime deadlines;
- structured lifecycle logs.

A single scheduler keeps global limits and fairness atomic. Sharding by installation is a later scaling option if measurements show the single object is a bottleneck.

Suggested states:

```text
Job:
  queued -> provisioning -> waiting_for_assignment -> running -> completed
         -> cancelled | failed

RunnerAttempt:
  created -> starting -> online -> assigned -> stopped
          -> timed_out | failed
```

A repeated `queued` event is a nudge, not blindly a duplicate: ignore it when a viable attempt exists, create another attempt when none exists, and always ignore it after terminal state.

### Runner Container Durable Object

Each provisioning attempt gets a globally unique runner name and deterministic Container DO identity, for example `j-{repositoryID}-{jobID}-{attempt}`. The scheduler, not the container, owns business lifecycle state.

The runner spawned because job A queued is not guaranteed to execute job A. GitHub assigns any compatible idle runner. `workflow_job.in_progress` supplies the actual `runner_name`; that event binds the GitHub job to the Container DO. Completion cleanup follows the assigned runner name, never the job that originally caused a runner to be provisioned.

If a job completes before assignment, the scheduler waits a short grace period and stops its provisioned attempt only if that attempt remains unassigned. It must not kill an attempt that has since taken another job.

### Two deadlines

- **Assignment deadline:** starts when the container starts. An unassigned runner should survive minutes, not six hours.
- **Runtime deadline:** starts when GitHub reports the job `in_progress`; default near GitHub's six-hour maximum and configurable.

Natural one-job runner exit remains the normal path. `workflow_job.completed` starts a short graceful-exit window, then the scheduler stops the proven assigned container if it remains alive.

### Reconciliation

A scheduled path discovers private-repository jobs that remain queued after a
webhook is lost. Both intake sources use the same admission, idempotency,
capacity, and Runner Attempt creation rules, but only a real Workflow Event
has a Delivery. Scheduler alarms separately enforce assignment and runtime
deadlines.

## Security decisions

V1 supports private repositories only, on personal accounts and organizations. App installation identifies eligible repositories, but it does not make hostile fork code safe. Public-repository execution remains out of scope until Jitney has an explicit fork and event trust policy.

For every accepted event, Jitney derives installation and repository IDs only from the verified payload, confirms their relationship, requests a short-lived installation token restricted to that repository, and uses the repository-level JIT endpoint. There is no configured singleton installation ID.

The runner receives only the single-use JIT configuration. It never receives the App private key, webhook secret, installation token, Worker bindings, or Cloudflare credentials. The native lifecycle spike must test whether the JIT value appears in environment variables, logs, process arguments, or `/proc`; the entrypoint clears its environment copy before launching the runner.

Structured secret-redacted logs are required in v1. Correlation fields include delivery, installation, repository, workflow job, runner name, container, lifecycle transition, and stop reason. A dashboard remains out of scope.

## Process supervision

Cloudflare's current docs specify SIGTERM followed by SIGKILL after 15 minutes. Jitney should not pay for that grace period. The image uses tini as PID 1 for subreaping and a Jitney supervisor as its child. The supervisor owns the runner process group and optional rootless dockerd process.

On stop, the supervisor sends SIGINT to the runner group, waits a measured grace period, sends SIGKILL if needed, stops dockerd, reaps children, and exits. A bare `exec run.sh` is insufficient because it cannot implement bounded escalation.

## Product corrections

- Publish four opaque canonical labels: `jitney`, `jitney-4cpu`, `jitney-docker`, and `jitney-docker-4cpu`. Do not promise a composable grammar. Require exactly one recognized Jitney label and reject unsupported requested labels that the minted runner cannot satisfy.
- Keep two user-visible sizes, but do not bind `jitney` to standard-3 yet. Measurements compare custom 1 vCPU / 4 GiB / 8 GB against standard-3 on representative workloads.
- Cloudflare Containers officially support rootless DinD. Rootless Docker is the compatibility baseline, but Jitney's glibc image and GitHub Actions behaviors still need proof. Podman is tested separately in CLI-wrapper, Docker-socket, and native runner-hook modes; it replaces Docker only if the workflow corpus passes and measurements show a real advantage. Docker labels ship only after the engine experiments establish their exact meaning.
- The minimal glibc image includes maintained Node LTS and Python 3 versions. Automated updates and compatibility tests are part of that promise.
- Replace class-level `max_instances` as the product control with scheduler-owned defaults: global concurrency, per-installation concurrency, maximum pending jobs, assignment timeout, and maximum runtime.
- Say "no runner fleet to manage," not "zero infrastructure."

## Measurement corrections

Ticket 9 must report p50/p95 rather than a single average and define timestamps precisely. It compares the two candidate default sizes across checkout/setup, Node, Python, compilation, and Docker workloads. Cost attribution includes startup, shutdown, unassigned attempts, Worker/DO overhead, disk, memory, CPU, and egress. "Warm runner" is not the right category because every runner has a fresh instance; useful cohorts are first launch after deploy and subsequent unique launches with the image already prefetched.
