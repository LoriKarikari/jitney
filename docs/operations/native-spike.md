# Native spike deployment record

This is a point-in-time record of the first end-to-end deployment on
2026-07-11. It contains the identifiers needed to reproduce that baseline, not
credentials or payload bodies. The Worker version below is the one that ran
the spike; later merges supersede it. For current live evidence see
[workload-compatibility.md](workload-compatibility.md) and
[lifecycle-evidence.md](lifecycle-evidence.md).

## Deployment

- Worker: `jitney`
- Endpoint: `https://jitney.lori-karikari.workers.dev/webhooks/github`
- Worker version: `4b2df390-e164-4f82-b769-b3460e654fb5`
- Container application: `jitney-runner`
- Container image digest: `sha256:a092aeb711ad79d013212a3d3eb98ac7b099310a849c99405310688d1f03232c`
- Container instance type: `standard-2` (1 vCPU, 6 GiB memory, 12 GB disk)
- Maximum instances: 5
- GitHub Actions runner: `2.335.1`
- Base userspace: Ubuntu 24.04, glibc
- Process entrypoint: tini, then `jitney-supervisor`, then the runner in a new session

The planned custom 1-vCPU/4-GiB/8-GB shape was not available on this non-Enterprise Cloudflare account. `standard-2` is the nearest supported shape that preserves the 1-vCPU requirement. This is still a spike candidate, not the final `jitney` size.

## Verification

- Local workerd tests verify raw-body HMAC handling and durable Scheduler acceptance.
- A real GitHub App ping redelivery reached the deployed endpoint and received `204` after signature verification.
- The linux/amd64 container image builds successfully on the same Dockerfile used by Wrangler.
- Local image inspection confirmed the non-root `runner` identity, glibc linkage, runner version, writable work directory, and tini/supervisor entrypoint.

## Live workflow

The first two dispatches (runs `29154536075` and `29154963410`) ran before the GitHub App webhook was active. GitHub only exposes the existing App registration's **Active** checkbox in its settings UI, so those deliveries were submitted manually with the real webhook secret and actual job identifiers. Both proved the deployed HMAC, payload-validation, durable-acceptance, App-authentication, repository-restriction, JIT-generation, and container-start path.

After enabling the webhook, the third dispatch completed fully automatically with GitHub delivering every event itself:

- Workflow run: `29159003301`
- Workflow job: `86560757212`
- Runner: `jitney-1297261275-86560757212-1`
- Container identity: `attempt-1297261275-86560757212-1`
- Job started: `2026-07-11T16:01:28Z`
- Job completed: `2026-07-11T16:01:34Z`
- Conclusion: `success`
- Steps: setup, runner inspection, and completion all succeeded
- Worker logs: `workflow_job` deliveries received and processed through `Scheduler.accept`
- Post-run container state: zero active and zero assigned instances

The runner exited naturally after the job and Cloudflare reclaimed the container. The full queued-to-completed lifecycle is now automatic.
