# Lifecycle and secret-containment evidence

This page records the evidence gathered for issue #12. The fixture repository is
private because public repositories are outside Jitney's execution boundary.
Values that could grant access are not copied here.

## Correlation record

Worker logs are JSON objects with an event name, millisecond timestamp, and the
identifiers known at that point. The allowed correlation fields are:

- Worker deployment ID
- GitHub delivery, installation, repository, and workflow job IDs
- attempt number, runner name, and container name
- Cloudflare container ID
- action, state, outcome, conclusion, provisioning step, exit code, and stop
  reason

The lifecycle event names are:

| Boundary | Events |
| --- | --- |
| Ingress | `webhook_received`, `webhook_classified` |
| Scheduler | `scheduler_transition`, `runner_provisioning_started`, `runner_provisioning_succeeded`, `runner_provisioning_failed`, `runner_attempt_expired`, `runner_reclaim_failed` |
| Container | `runner_container_started`, `runner_container_stopped`, `runner_container_failed` |
| Supervisor | `runner_process_started`, `runner_shutdown_started`, `runner_shutdown_escalated`, `runner_process_exited` |

The logger accepts discriminated lifecycle records, so each event admits only
its valid correlation and outcome fields. It classifies the log level from the
event instead of trusting each caller. Raw errors, headers, webhook bodies,
environment objects, and GitHub API responses are outside the interface. A
second value filter replaces PEM blocks, JWTs, GitHub token formats, webhook
signatures, and long base64 strings with `[REDACTED]`.

Automated tests cover recognizable canaries for an App private key, JWT,
installation token, webhook signature, and JIT configuration. Another test
reconstructs queued admission, provisioning, assignment, and completion from
records carrying the same workflow job, runner, and container identities.
Provisioning failure tests also prove that the typed failure step is logged
without rendering the underlying cause.

## Live process inspection

The containment workflow ran in the private fixture repository on 2026-07-11.

| Field | Value |
| --- | --- |
| Workflow run | `29170245728` |
| Job | `86590125234` |
| Runner | `jitney-1297261275-86590125234-1` |
| Runner version | `2.335.1` |
| Worker deployment | `0dca5e2c-2826-4c9c-b4de-8afb0853a345` |
| Runner image | `sha256:a092aeb711ad79d013212a3d3eb98ac7b099310a849c99405310688d1f03232c` |
| Result | success |

The workflow inspected every readable `/proc/<pid>/environ` and
`/proc/<pid>/cmdline` owned by its UID. It printed names, counts, and lengths,
but never values.

- Seven same-UID processes were readable.
- No App ID, App private key, webhook secret, Cloudflare API token, Cloudflare
  account ID, or other Worker binding name was present.
- `JIT_CONFIG` was visible in two process environments.
- Three process command lines contained `--jitconfig`; each argument was 4,124
  bytes.
- After the job, GitHub reported zero registered runners and Cloudflare reported
  zero active or assigned container instances.

## JIT bootstrap exposure

The JIT configuration crosses the Container boundary as `JIT_CONFIG`. The Go
supervisor removes it from the environment before starting the runner, but
Linux still exposes the original environment of parent processes through
same-UID-readable `/proc`. The runner command line also contains the consumed
value because GitHub Runner accepts it through `--jitconfig`.

This is real exposure inside the workload container. It lasts until those
processes exit and is readable by another process running as the same UID. The
value is single-use, names one runner, and does not contain the App private key,
webhook secret, Cloudflare credentials, or a reusable installation token. It
cannot mint another runner or call the Jitney control plane. Jitney therefore
treats it as workload-scoped bootstrap material rather than a control-plane
credential.

The private fixture workflow at `.github/workflows/secret-containment.yml`
keeps this boundary under test. A future Runner release that supports reading
JIT configuration from a protected file descriptor could narrow the exposure;
with the current `--jitconfig` interface, it cannot be removed completely.

## Assignment expiry

The probe for issue #25 ran in the private fixture repository on 2026-07-12. It
dispatched a real workflow, then deleted the freshly registered runner from
GitHub before it could claim the queued job. That leaves an unassigned Runner
Attempt that only the Scheduler's deadline sweep can clean up.

| Field | Value |
| --- | --- |
| Workflow run | `29193843969` |
| Job | `86653163595` |
| Runner | `jitney-1297261275-86653163595-1` |
| Container identity | `attempt-1297261275-86653163595-1` |
| Worker deployment | `68ad9a92-69bb-4024-9807-5d14357ffd3c` |
| Stop reason | `assignment_deadline` |

Observed sequence:

- The queued delivery was accepted, the runner provisioned, and the container
  started.
- The runner registration was deleted while `busy=false`; GitHub kept the job
  queued with no assigned runner.
- Five minutes after acceptance, the sweep emitted `runner_attempt_expired`
  with the correlation identifiers above and invoked `destroy` on the Runner
  Container.
- GitHub reported zero registered runners and the container instance reported
  `stopped`.

The deliberately orphaned job stayed queued because no new `queued` delivery
arrived for it, so this deadline probe was cancelled manually. The later
[webhook-loss recovery](#webhook-loss-recovery) probe proves that scheduled
reconciliation now recovers this class of queued job.

An earlier fixture design used GitHub concurrency groups to hold a job
unassigned. That cannot work: GitHub keeps a concurrency-blocked job in
`pending` and only emits `workflow_job: queued` once the lock releases, so the
control plane never sees the job while it is blocked.

## Webhook-loss recovery

The reconciliation probe ran in the private fixture repository on 2026-07-12
against Worker deployment `aeb97d5f-3fc6-43a3-a644-203641036aa1`. The GitHub
App webhook URL was temporarily changed to an unreachable host before the
workflow was dispatched. GitHub recorded the resulting `workflow_job`
delivery at `17:58:53Z` with HTTP 502. The original webhook URL was then
restored while the job remained queued.

| Field | Value |
| --- | --- |
| Workflow run | `29203003654` |
| Job | `86677443701` |
| Runner | `jitney-1297261275-86677443701-1` |
| Worker deployment | `aeb97d5f-3fc6-43a3-a644-203641036aa1` |

Observed sequence:

- The job remained queued with no runner after the failed webhook delivery.
- The scheduled reconciliation pass started at `18:00:45Z`, discovered one
  queued job, and admitted it at `18:00:47Z` without a Delivery identity.
- Provisioning started at `18:00:48Z` and succeeded at `18:00:50Z`.
- GitHub assigned the job to the reconciled Runner Attempt at `18:00:55Z`.
- The workflow completed successfully at `18:01:08Z`.
- The final GitHub runner inventory was zero. The GitHub App webhook URL was
  also verified to match its original value after the probe.

This proves that the cron trigger, GitHub discovery adapter, reconciled Job
Intake, provisioning, and cleanup recover a queued job whose webhook never
reached Jitney.

## Runtime expiry

The probe for issue #26 ran in the private fixture repository on 2026-07-12.
The deployment was overridden with `RUNTIME_TIMEOUT_MS=120000`, and a fixture
job slept for ten minutes.

| Field | Value |
| --- | --- |
| Workflow run | `29195490505` |
| Job | `86657587633` |
| Runner | `jitney-1297261275-86657587633-1` |
| Container identity | `attempt-1297261275-86657587633-1` |
| Worker deployment | `f1fe9cac-379c-42a1-9804-11e1fbbf3d99` |
| Stop reason | `runtime_deadline` |

Observed sequence:

- The job started at `14:02:08Z` and would have run for ten minutes.
- The sweep emitted `runner_attempt_expired` with
  `stopReason: runtime_deadline` at `14:07:00Z` and destroyed the Runner
  Container; the instance reported `stopped`.
- Deleting the runner registration failed with `runner_reclaim_failed` at step
  `runner_deletion`: GitHub refuses to delete a busy runner. The container was
  already destroyed because reclaim bounds the paid resource first.
- GitHub detected the lost runner and reported the job `completed: failure` at
  `14:12Z`, then removed the JIT registration itself. The end state was zero
  registered runners with no manual cleanup: a failed busy-runner deletion is
  self-healing for single-use JIT runners.

Termination fired about three minutes after the two-minute deadline: the
pending assignment-deadline alarm was later than the runtime deadline, and
accepting the assignment did not pull the alarm forward. With the default
one-hour runtime timeout the ordering hides this, because the five-minute
assignment alarm always fires first and rearms on the runtime deadline. The
fix rearms the alarm on assignment whenever the runtime deadline precedes the
scheduled wake-up.
