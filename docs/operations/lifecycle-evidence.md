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
| Scheduler | `scheduler_transition`, `runner_provisioning_started`, `runner_provisioning_succeeded`, `runner_provisioning_failed` |
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
