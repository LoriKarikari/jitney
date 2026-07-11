# Native spike deployment record

This record contains identifiers needed to reproduce the first deployment. It does not contain credentials or payload bodies.

## Deployment

- Worker: `jitney`
- Endpoint: `https://jitney.lori-karikari.workers.dev/webhooks/github`
- Worker version: `356308f2-fc93-4e79-9829-7eaed0f9a3dd`
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

The first dispatch was queued as workflow run `29154536075` and was cancelled after no webhook arrived. GitHub's REST API confirmed that the App is subscribed to `workflow_job`, and a real App ping redelivery reached the deployed endpoint with status `204`.

A second dispatch, workflow run `29154963410`, completed successfully. Because GitHub only exposes the existing App registration's **Active** webhook checkbox in its settings UI, the queued event was submitted manually using the real webhook secret and the actual queued workflow job identifiers. It passed the same deployed HMAC, payload-validation, durable-acceptance, App-authentication, repository-restriction, JIT-generation, and container-start path as an automatic delivery.

- Workflow run: `29154963410`
- Workflow job: `86550471243`
- Runner: `jitney-1297261275-86550471243-1`
- Container identity: `attempt-1297261275-86550471243-1`
- Job started: `2026-07-11T13:50:53Z`
- Job completed: `2026-07-11T13:50:58Z`
- Conclusion: `success`
- Steps: setup, runner inspection, and completion all succeeded
- Post-run container application state: zero active and zero assigned instances

The runner exited naturally after the job. Automatic queued, in-progress, and completed delivery remains gated only by enabling the App webhook in GitHub's settings UI; the Worker handlers for all three actions are deployed.
