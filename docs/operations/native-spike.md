# Native spike deployment record

This record contains identifiers needed to reproduce the first deployment. It does not contain credentials or payload bodies.

## Deployment

- Worker: `jitney`
- Endpoint: `https://jitney.lori-karikari.workers.dev/webhooks/github`
- Worker version: `3f967df5-ddb1-4fa8-98e0-6922825ac0da`
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

The first dispatch was queued as workflow run `29154536075` and was cancelled after no webhook arrived. A second dispatch, workflow run `29154963410`, remained queued for the same reason. GitHub's REST API confirmed that the App is subscribed to `workflow_job`, and a manual ping redelivery succeeded. The remaining blocker is the existing App registration's **Active** webhook checkbox, which GitHub only exposes in the settings UI.

Once the checkbox is enabled, dispatch the manual workflow again and append the workflow run ID, job ID, reported runner name, container identity, lifecycle timestamps, conclusion, and reclamation observation here.
