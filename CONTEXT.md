# Jitney

Ephemeral, per-job GitHub Actions runners on Cloudflare Containers. A GitHub
App receives `workflow_job` webhooks, mints just-in-time runner config, and
boots a throwaway Cloudflare Container that runs exactly one job and exits.
No standing fleet, no idle capacity, no servers to manage.

## Language

**Workflow Event**:
A GitHub `workflow_job` webhook delivery carrying the job's lifecycle state
(`queued`, `in_progress`, `completed`), labels, repository, and installation
identity.
_Avoid_: webhook payload, event payload

**Delivery**:
A single GitHub webhook delivery, identified by a unique GUID. The same
workflow event may be delivered more than once (manual redelivery, retry).
_Avoid_: request, callback

**Job**:
A GitHub Actions workflow job that Jitney tracks through its lifecycle. One
job runs on exactly one runner, but the runner that claims it may not be the
one whose provisioning was triggered by that job's queued event.
_Avoid_: task, build

**Runner Attempt**:
A single provisioning cycle: mint a JIT config, start a Container, wait for
GitHub to assign a job to that runner. An attempt may succeed, time out, fail,
or be stopped after the job completes.
_Avoid_: container instance, runner instance

**Assignment**:
The binding between a GitHub Workflow Job and the Runner Attempt that claimed
it, established when GitHub reports `workflow_job.in_progress` with a
`runner_name`. Cleanup follows the assigned Attempt, not the Job that
triggered provisioning.
_Avoid_: mapping, association

**Runner Attempt Operations**:
The privileged control-plane work that provisions or reclaims a Runner
Attempt. It owns GitHub App authentication, repository-scoped credentials,
Runner Container operations, their required ordering, and failure
classification.
_Avoid_: GitHub helper, container helper

**Runner Container**:
The ephemeral Cloudflare Container that executes one JIT runner process. Its
disk is fresh per boot, its state is owned by the Scheduler, and it exits
after one job.
_Avoid_: VM, instance, pod

**Job Intake**:
A queued Job presented to the Scheduler from either a Delivery-backed Workflow
Event or reconciliation. Both sources share admission, idempotency, capacity,
and Runner Attempt creation. Only a Workflow Event carries Delivery identity.
_Avoid_: synthetic webhook, fabricated delivery

**Scheduler**:
The global Durable Object that owns Job Intake, job lifecycle, Runner Attempts,
admission control, deadlines, and reconciliation.
_Avoid_: queue, controller, orchestrator

**Ingress Worker**:
The narrow webhook handler that verifies HMAC, normalizes the event, durably
submits it to the Scheduler, and returns `202` within GitHub's ten-second
deadline. It does not mint tokens or start containers.
_Avoid_: API, endpoint, handler

**JIT Config**:
A single-use, short-lived configuration string minted via GitHub's
`generate-jitconfig` endpoint. Passed to the runner so it can register and
claim one job. Consumed on use; not reusable.
_Avoid_: registration token, runner token

**Control Plane**:
The Ingress Worker, Scheduler, Runner Container DOs, and reconciler. Holds
App credentials, webhook secrets, and installation tokens. Never enters a
runner.
_Avoid_: backend, server

**Data Plane**:
The runner process and its job steps. Receives only the JIT config. Cannot
reach control-plane credentials, Worker bindings, or Cloudflare account
secrets.
_Avoid_: worker, agent

**Label**:
A GitHub Actions `runs-on` label that routes a job to a runner. Jitney
publishes four opaque canonical labels: `jitney`, `jitney-4cpu`,
`jitney-docker`, `jitney-docker-4cpu`. Exactly one Jitney label per job.
_Avoid_: tag, selector

**Deployment**:
One named Jitney installation: a Worker, its container application, and a
GitHub App in one Cloudflare account. The name is the CLI handle; an
immutable ULID minted at install is the ownership identity that every
ownership marker and proof matches on.
_Avoid_: environment, instance

**Deployment Receipt**:
The non-secret cloud-side record of one Deployment, stored as JSON in the
shared account-level `jitney-receipts` KV namespace under the Deployment
name. It carries identity, phase, resource inventory, current and previous
versions, and capped operation history. It survives Worker deletion and is
reachable from any machine.
_Avoid_: state file, config, local state

**Lifecycle Phase**:
The Deployment's coarse state: `installing | active | upgrading | repairing
| destroying`. Receipts own deployment-level phases; per-resource recovery
state belongs to Alchemy's state store.
_Avoid_: status

**Operation Lease**:
The single-writer lock recorded inside a Deployment Receipt: `{operation,
actor (user@host), expiresAt}`. Fifteen-minute TTL, renewed by the running
command, released together with the phase transition in the same receipt
write. An expired lease blocks every command until `repair` releases it.
_Avoid_: mutex, lock file

**Resource Classification**:
The result of comparing one recorded resource with the live control plane:
`ok | missing | drifted | orphan | unknown`. `unknown` means the probe was
inconclusive; Jitney never infers live state from a failed request.
_Avoid_: assumed healthy, probably missing

## Relationships

- A **Delivery** carries one **Workflow Event**.
- **Job Intake** receives either a Delivery-backed **Workflow Event** or a
  reconciled queued **Job**.
- A **Job** has zero or more **Runner Attempts**.
- An **Assignment** binds one **Job** to one runner name, reported by
  `workflow_job.in_progress`.
- A **Runner Container** executes at most one **Job**, then exits.
- The **Scheduler** owns all **Job** and **Runner Attempt** lifecycle state.
- The **Ingress Worker** never touches GitHub APIs or container startup.
- The **Control Plane** never enters the **Data Plane**.
- A **Deployment** has exactly one **Deployment Receipt**, keyed by its name.
- A **Deployment Receipt** holds at most one **Operation Lease** at a time.
- Deployment ownership always matches on the ULID, never the name.
- `list` assigns a **Resource Classification** without changing either control plane.

## Architecture

```text
GitHub workflow_job webhook
  → Ingress Worker (HMAC verify, normalize, durable accept, 202)
    → Scheduler.accept(Delivery-backed Workflow Event)

Cloudflare cron
  → GitHub queued-job discovery
    → Scheduler.reconcile(queued Job without Delivery identity)

Scheduler Job Intake
  → admission + Runner Attempt creation
    → JIT mint + Runner Container start
      ← workflow_job.in_progress (bind Job to Runner Attempt)
      ← workflow_job.completed (terminal state, natural exit)

Scheduler alarms
  → assignment and runtime deadline enforcement
```

## Security model

- V1 accepts private repositories only. App installation identifies eligible
  repositories; it is not a trust boundary for hostile fork code.
- Installation and repository identity are derived from the verified webhook
  payload, never from request parameters.
- Installation tokens are restricted to the verified repository.
- The runner receives only the JIT config. No App key, webhook secret,
  installation token, or Cloudflare credential enters the data plane.
- Structured logs are secret-redacted and correlated by delivery, installation,
  repository, job, runner, container, transition, and stop reason.

## Product scope

- Four opaque labels, not a composable grammar.
- Two sizes: `jitney` (default, hardware decided by measurement) and
  `jitney-4cpu` (4 vCPU / 12 GiB ceiling).
- Minimal glibc runner image on GitHub's maintained `actions-runner` base, with
  Node LTS and Python 3. No `ubuntu-latest` parity claim.
- Docker labels conditional on a compatibility spike. Rootless Docker is the
  baseline; Podman is a possible alternative if it passes full workflow
  compatibility with a measured advantage.
- Scheduler-owned controls: global concurrency, per-installation concurrency,
  max pending jobs, assignment timeout, max runtime.
- Out of v1: public repos, cache backend, sticky disks, dashboard, runner
  groups, more sizes, arm64, GHES, Windows, GPU, >4 vCPU.
