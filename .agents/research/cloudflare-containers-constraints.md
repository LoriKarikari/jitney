# Cloudflare Containers: constraints and pricing

Asset for ticket 5. All platform facts pulled from developers.cloudflare.com on 2026-07-11; comparison prices from docs.github.com and runs-on.com the same day. Feeds the scope discussion in ticket 8 and the measurement work in ticket 9.

## Instance types

Six predefined types, plus custom sizes ([limits page](https://developers.cloudflare.com/containers/platform-details/limits/)):

| Type | vCPU | Memory | Disk |
|---|---|---|---|
| lite | 1/16 | 256 MiB | 2 GB |
| basic | 1/4 | 1 GiB | 4 GB |
| standard-1 | 1/2 | 4 GiB | 8 GB |
| standard-2 | 1 | 6 GiB | 12 GB |
| standard-3 | 2 | 8 GiB | 16 GB |
| standard-4 | 4 | 12 GiB | 20 GB |

Custom instance types (set `vcpu`, `memory_mib`, `disk_mb` in wrangler config) are boxed in by: 1 vCPU minimum, **4 vCPU / 12 GiB memory / 20 GB disk maximum**, at least 3 GiB memory per vCPU, and at most 2 GB disk per GiB of memory. Sub-1-vCPU workloads must use the predefined `lite`/`basic` types. Larger sizes require contacting Cloudflare (account team, support ticket, or their request form). Source: https://developers.cloudflare.com/containers/platform-details/limits/

The ceiling confirms the map's out-of-scope call: nothing bigger than a 4-vCPU Linux box exists on this platform. `standard-3` matches GitHub's documented `ubuntu-latest` shape (2 CPU / 8 GB RAM), but shape matching does not make it the right economic default. Custom 1 vCPU/4 GiB/8 GB and standard-3 remain candidates until ticket 9 measures representative jobs.

## Images

- **Max image size = the disk of the instance type it runs on** (so 16 GB for standard-3, 20 GB absolute max). Source: https://developers.cloudflare.com/containers/platform-details/limits/
- **Total image storage per account: 50 GB.** Old images must be deleted with `wrangler containers delete` to free space, and deleting an image breaks rollback to Worker versions that referenced it. Source: same page, footnote 1.
- Images are uploaded to Cloudflare's registry on deploy and **pre-fetched globally** so instances can start near the request. Source: https://developers.cloudflare.com/containers/platform-details/ (Lifecycle page)
- Must be built for **linux/amd64**; each instance runs in its own VM for isolation. Source: same Lifecycle page. No Windows, no arm64 — consistent with the map's scope.

Practical consequence: the 50 GB account cap is the real image constraint. A fat kitchen-sink runner image (GitHub's own ubuntu image is tens of GB) is off the table; a lean runner image also matters for cold start since start time is "dependent on image size" (Lifecycle page).

## Account concurrency caps

Per account ([limits page](https://developers.cloudflare.com/containers/platform-details/limits/)):

| Resource | Cap |
|---|---|
| Concurrent memory | 6 TiB |
| Concurrent vCPU | 1,500 |
| Concurrent disk | 30 TB |

For standard-3 runners the platform's binding limit is vCPU: 1,500 / 2 = **750 concurrent jobs** (memory allows 768, disk 1,875). Platform capacity is unlikely to bind v1, but concurrency remains a product and cost risk. The scheduler needs global and per-installation admission limits, a durable pending queue, and fair draining; a class cap cannot safely drop queued webhooks.

## DinD

Officially supported, and the docs FAQ now documents the exact recipe gh-runner-broker discovered the hard way ([FAQ](https://developers.cloudflare.com/containers/faq/)):

- Containers run **without root privileges**, so the base must be `docker:dind-rootless`.
- `dockerd` must start with `--iptables=false --ip6tables=false` because Containers do not support iptables manipulation.
- The FAQ links a complete working example: https://github.com/th0m/containers-dind

This matches the prior-art brief's findings (rootless, no iptables, host networking) — but it's now first-party documented rather than a hack, which de-risks the `jitney-docker` label considerably.

## Cold start and lifecycle

From https://developers.cloudflare.com/containers/platform-details/ and https://developers.cloudflare.com/containers/faq/:

- A cold start (novel instance ID, first boot) runs the image entrypoint from scratch; Cloudflare quotes **"often in the 1-3 second range"**, dependent on image size and entrypoint work. Our runner's real cold start (register + pick up job) is on top of that — that's ticket 9's measurement.
- Instances start at the **nearest location with a pre-fetched image**; Cloudflare pre-warms machines behind the scenes and you're not charged for pre-warmed images, only actively running instances.
- **All disk is ephemeral** — every boot gets a fresh disk from the image. Exactly the guarantee an ephemeral runner wants.
- Shutdown is **SIGTERM, then SIGKILL after 15 minutes**. Jitney should self-escalate after a much shorter measured grace period so a hung process does not bill for the full platform window.
- No `sleepAfter` means the container runs until its process exits or the host restarts (no guaranteed uptime) — the runner exiting after its one job is the natural stop, with the orphan-cleanup timer as backstop.
- Inbound is HTTP-only through the Worker (no raw TCP/UDP from end users). Irrelevant to Jitney: the runner only makes outbound connections to GitHub.
- OOM restarts the instance; no swap.

## Pricing (Workers Paid, $5/month)

From https://developers.cloudflare.com/containers/pricing/ — billed per 10 ms of active runtime; charges start when a request starts the container and stop when it sleeps:

| Meter | Included/month | Overage rate | Basis |
|---|---|---|---|
| Memory | 25 GiB-hours | $0.0000025 per GiB-second | provisioned |
| CPU | 375 vCPU-minutes | $0.000020 per vCPU-second | **active usage only** |
| Disk | 200 GB-hours | $0.00000007 per GB-second | provisioned |

Egress (same page): North America & Europe $0.025/GB after 1 TB/month included; Oceania/Korea/Taiwan $0.05/GB after 500 GB; everywhere else $0.04/GB after 500 GB. Workers requests and each container's Durable Object are billed separately under normal Workers/DO pricing (small at CI volumes).

There is no published enterprise price list for Containers; larger instances and higher limits go through the account team (limits page). Enterprise-only perk documented: Logpush export of container logs (FAQ).

Key structural fact: **memory and disk bill on provisioned size for the full runtime; CPU bills only on active usage.** An idle-ish job on a standard-3 still pays the 8 GiB memory meter the whole time.

## Headline comparison: 5-minute 2-vCPU job

Marginal cost (ignoring included allotments), standard-3 (2 vCPU / 8 GiB / 16 GB), 300 seconds:

| Meter | Math | Cost |
|---|---|---|
| CPU @ 100% both cores | 600 vCPU-s × $0.000020 | $0.0120 |
| Memory | 2,400 GiB-s × $0.0000025 | $0.0060 |
| Disk | 4,800 GB-s × $0.00000007 | $0.0003 |
| **Total (CPU-saturated)** | | **≈ $0.0183** |

At 50% average CPU the total drops to ≈ $0.0123; the memory+disk floor is ≈ $0.0063 regardless of CPU.

| Option | Rate | 5-min job | Source |
|---|---|---|---|
| **Jitney (CF standard-3)** | ≈ $0.0013–0.0037/min (CPU-dependent) | **$0.006–0.018** | pricing math above |
| **GitHub-hosted `ubuntu-latest`** (private repo) | $0.006/min, rounded up per minute | **$0.030** | https://docs.github.com/en/billing/reference/actions-runner-pricing (rate reduced Jan 2026: https://github.blog/changelog/2026-01-01-reduced-pricing-for-github-hosted-runners-usage/) |
| **runs-on spot (2cpu Linux)** | ≈ $0.0009/min AWS spot passthrough, no per-minute markup | **≈ $0.0045** (+ license fee) | https://runs-on.com/pricing/ |

Reading:

- Jitney is **~1.6–5× cheaper than GitHub-hosted** depending on CPU utilization — real but not a headline-grabbing gap, especially after GitHub's January 2026 price cut, and GitHub-hosted is free for public repos and within plan-included minutes.
- **runs-on spot beats Jitney on raw per-minute cost** (spot EC2 is very cheap), but requires an AWS account, a CloudFormation deploy, and carries a license fee plus spot-interruption risk. Spot prices vary by region and market.
- Jitney's honest positioning is therefore **not "cheapest"**: it has no runner fleet to manage, scales to zero with per-10ms billing and no per-minute rounding, and aims for fast ephemeral boot. It still requires a paid Cloudflare account, GitHub App setup, secrets, and deployment. Ticket 9 must measure whether end-to-end startup preserves the speed claim.

## Facts most likely to move ticket 8

1. 4 vCPU / 12 GiB is the absolute ceiling — no big-runner tier, ever (without enterprise negotiation).
2. 50 GB account image storage forces a lean runner image; lean also serves cold start.
3. DinD is first-party documented (`docker:dind-rootless`, `--iptables=false`), but Jitney's glibc image and GitHub-specific Docker behavior still require a compatibility spike.
4. Billing is provisioned-memory + active-CPU: right-sizing the default directly moves cost per job.
5. Platform capacity is generous; scheduler admission and operator bills still need explicit controls.
6. Per-minute rounding on GitHub's side means Jitney's advantage is largest on short jobs: sub-minute jobs cost GitHub a full $0.006 minimum while Jitney bills actual seconds.
