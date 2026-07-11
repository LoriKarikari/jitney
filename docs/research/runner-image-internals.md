# Runner image internals: boot speed and process correctness

Asset for ticket 11, feeding the v1 spec (ticket 10). Every load-bearing claim carries a URL; sources checked 2026-07-11. Where a number can only come from measurement, it's flagged for ticket 9 rather than guessed.

## 1. PID 1, reaping, and the SIGTERM flow

### What the runner actually is, process-wise

`run.sh` → `run-helper.sh` → `Runner.Listener`, which spawns a `Runner.Worker` per job, which spawns the step processes. Job steps can leave orphans (a step backgrounds a daemon and exits); those get reparented to PID 1, and something must reap them or they pile up as zombies for the container's lifetime.

The runner's own scripts give us most of the contract, verified from source:

- `run.sh` has two modes. Default mode just loops on `run-helper.sh` with **no signal trap at all** — as PID 1 that's broken, because the kernel doesn't apply default signal dispositions to PID 1, so an untrapped SIGTERM is silently ignored. With `RUNNER_MANUALLY_TRAP_SIG` set, `run.sh` enables job control, runs the helper in its own process group, and traps INT and TERM, forwarding **SIGINT to the whole helper process group** (`kill -INT -$PID`). Source: [run.sh](https://github.com/actions/runner/blob/main/src/Misc/layoutroot/run.sh). The official image sets `ENV RUNNER_MANUALLY_TRAP_SIG=1` for exactly this reason: [images/Dockerfile](https://github.com/actions/runner/blob/main/images/Dockerfile).
- SIGINT is the graceful-stop signal for `Runner.Listener` (maintainer guidance: `pkill -2 Runner.Listener`): [actions/runner#2190](https://github.com/actions/runner/issues/2190). So "SIGTERM to the container" becomes "SIGINT to the listener group" via the trap — SIGTERM in, graceful stop out.
- `run-helper.sh` interprets `Runner.Listener` exit codes: 0 = done (a JIT runner lands here after its one job), 1 = terminated error (helper exits 0, no retry), 2 = retryable (loop restarts the listener), 3/4 = self-update paths. It also honors `RUNNER_WAIT_FOR_DOCKER_IN_SECONDS`, polling `docker ps` before starting the listener — free DinD sequencing we don't have to write. Source: [run-helper.sh.template](https://github.com/actions/runner/blob/main/src/Misc/layoutroot/run-helper.sh.template).
- A JIT runner (`./run.sh --jitconfig <encoded>`) executes at most one job and is then removed automatically — no deregistration call needed from us. Source: [GitHub Docs, secure use / JIT runners](https://docs.github.com/en/actions/reference/security/secure-use).

### PID 1 and the supervisor

Put **tini** at PID 1 as a subreaper. It reaps orphaned descendants and forwards signals, but it does not provide timed escalation or coordinate an optional Docker daemon. Its direct child is therefore a small Jitney supervisor rather than `run.sh`. Source for tini's behavior: [krallin/tini README](https://github.com/krallin/tini).

The supervisor launches `run.sh` in a dedicated **session** and launches rootless dockerd when the image flavor requires it. `run.sh` creates additional process groups for its helper and listener, so killing only the original group is insufficient. The supervisor owns the bounded shutdown contract:

1. receive SIGTERM from tini;
2. signal every process in the runner session with SIGINT for GitHub's graceful-stop path;
3. wait a measured grace period;
4. enumerate the session again and send SIGKILL to every survivor;
5. stop dockerd and reap children;
6. exit so Cloudflare can reclaim the instance.

Cloudflare's current lifecycle docs specify SIGTERM followed by platform SIGKILL after 15 minutes. Jitney self-escalates much sooner so a hung process cannot bill for the full grace window. `RUNNER_MANUALLY_TRAP_SIG=1` remains useful inside `run.sh`, but it is no longer the entire supervision design.

### Shutdown and deadline paths

**Normal completion:** `Runner.Listener` completes its one job and exits. The supervisor observes the runner exit, stops dockerd if present, reaps children, and exits. No control-plane stop is needed.

**Assignment deadline:** a started runner that never receives a job is stopped after a short scheduler-owned deadline measured in minutes. This is separate from maximum job runtime.

**Completion event:** `workflow_job.completed` identifies the actual assigned runner. The scheduler allows a short natural-exit grace, then asks that runner's Container DO to stop if it remains alive.

**Runtime deadline or operator stop:** Cloudflare sends SIGTERM to tini; tini forwards to the supervisor; the supervisor performs graceful SIGINT followed by its own bounded SIGKILL. Ticket 14 measures the grace period with a hung step and orphaned descendants.

## 2. Cold-start anatomy on Cloudflare

Between "Worker calls start" and "runner takes job":

1. **Instance placement + image availability.** Cloudflare pre-schedules instances and **pre-fetches images across the globe**; typical cold starts are on the order of **1–3 seconds**, dependent on image size and startup code ([architecture/lifecycle docs](https://developers.cloudflare.com/containers/platform-details/architecture/), [placement docs](https://developers.cloudflare.com/containers/platform-details/placement/)). Critically, Cloudflare **does not cache images pulled from Docker Hub, ECR, or GAR** — the pre-fetch machinery only works for images pushed to the **Cloudflare-managed registry** via `wrangler deploy`/`wrangler containers push` ([image management docs](https://developers.cloudflare.com/containers/platform-details/image-management/)). Decision this forces: **the runner image lives in Cloudflare's registry, full stop.** Pulling `ghcr.io/actions/actions-runner` at boot would put GitHub's CDN on the cold-start critical path with zero Cloudflare-side caching.
2. **Container start.** Filesystem materializes from the image (fresh every time — see §3), tini starts the entrypoint.
3. **Our startup code.** The supervisor consumes the single-use JIT bootstrap, removes its environment copy, starts optional rootless dockerd, then launches the runner in a dedicated session. Docker readiness is gated before the listener starts for Docker flavors.
4. **JIT session establishment.** `Runner.Listener` connects to GitHub's broker over HTTPS and may pick up any compatible queued job, not necessarily the job that caused this attempt to be created. The scheduler binds the actual job when `workflow_job.in_progress` reports `runner_name`. No App credential or installation token enters the container.

**What we control:** image size and layer structure, registry choice, startup ordering. **What we don't:** Cloudflare's placement/prefetch behavior and GitHub's session round-trip.

**Layer ordering:** registry pushes and pulls are layer-granular, so order layers by change frequency — base OS, then docker/toolchain blobs, then the runner tarball (updates every few weeks), then our entrypoint script last. A runner version bump then re-pushes and re-fetches only the runner layer and above, not the toolchain blobs. This mirrors the official Dockerfile's structure ([images/Dockerfile](https://github.com/actions/runner/blob/main/images/Dockerfile)).

**Honest size floor for a glibc runner image:** the runner layout is the dominant term — it bundles the .NET runtime and Node runtimes, several hundred MB unpacked. The base (`dotnet/runtime-deps:8.0-noble`, i.e. Ubuntu 24.04 with the .NET native dependency set) plus git/sudo/jq per the official Dockerfile adds a modest OS layer; the static docker engine + buildx for DinD adds a few hundred MB more. Realistic expectation: **roughly 1 GB uncompressed for the plain runner, more with DinD** — small enough to be a non-issue against Cloudflare's prefetching, but exact push size and cold-start contribution are ticket-9 measurements, not claims. What we should *not* do is chase a sub-200 MB image: the runner layout can't shrink, and Alpine/musl is ruled out because the runner's bundled tooling is glibc-linked (the broker's `fcntl64` bug).

## 3. Filesystem

- **Disk ceiling:** instance types top out at **20 GB disk** (standard-4, or custom instance types up to 20 GB / 12 GiB memory / 4 vCPU, with a documented ratio of **max 2 GB disk per 1 GiB memory** — so a 20 GB disk implies a ≥10 GiB-memory instance, which is a cost decision, not just a storage one). Source: [limits and instance types](https://developers.cloudflare.com/containers/platform-details/limits/).
- **Ephemerality:** the container disk is ephemeral; every start gets a **fresh disk from the image**. Persistence, if ever needed, goes through Durable Object storage, not the container filesystem. Sources: [container class docs](https://developers.cloudflare.com/containers/container-class/), [FAQ](https://developers.cloudflare.com/containers/faq/).
- **Image size counts against you:** the maximum image size equals the instance's available disk ([image management docs](https://developers.cloudflare.com/containers/platform-details/image-management/)) — a 1 GB image on a 20 GB instance leaves ~19 GB of working space for checkout, toolchain downloads, and docker layers. For a DinD job that builds fat images, budget accordingly: rootless dockerd's storage lives under the runner user's home on the same disk.
- **`_work` placement:** on the container disk, not tmpfs. The disk is already ephemeral (tmpfs's usual selling point), Cloudflare documents no tmpfs sizing control, and a tmpfs `_work` would compete with the job for the memory budget — the scarcer resource at these instance sizes. There is no durability to gain and RAM to lose.
- **Writability:** the root filesystem materialized from the image is writable (ephemeral overlay semantics — the docs describe it as starting fresh from the image each time rather than restricting writes). The runner runs as uid 1001 (`runner`) with passwordless sudo in the official layout, so jobs can `apt-get install` into the ephemeral disk like they do on GitHub-hosted runners.

## 4. Rootless DinD internals — why iptables-off and host networking

Cloudflare containers run **unprivileged** — no root-equivalent capabilities, no iptables manipulation, no tun devices. Cloudflare's plain-Containers [FAQ](https://developers.cloudflare.com/containers/faq/) officially supports rootless dockerd with `--iptables=false --ip6tables=false`; the Sandbox SDK guide also requires host networking for inner Docker operations. This proves platform capability, not GitHub Actions compatibility. Ticket 15 tests buildx, job containers, service containers, storage, networking, and shutdown before Docker labels ship. Understanding each piece:

- **uidmap (`newuidmap`/`newgidmap`):** rootless Docker runs dockerd and its containers inside a user namespace; the setuid helpers from the `uidmap` package map ranges from `/etc/subuid`/`/etc/subgid` so a container can have "many uids" while the real host identity stays the unprivileged runner user ([Docker rootless docs](https://docs.docker.com/engine/security/rootless/)). Inside the image we must create those subordinate ranges for uid 1001 at build time — there's no host admin to do it later.
- **Storage:** rootless Docker uses kernel overlayfs (`overlay2`) when the kernel allows unprivileged overlay mounts (mainline since 5.11), falling back to **fuse-overlayfs** otherwise ([storage driver selection docs](https://docs.docker.com/engine/storage/drivers/select-storage-driver/)). Ship fuse-overlayfs in the image as the fallback and let dockerd pick; which path Cloudflare's kernel actually takes is a one-line `docker info` check in the spike. The failure mode to avoid is dockerd silently falling back to `vfs`, which copies every layer and would eat the 20 GB disk fast.
- **Networking is where Cloudflare bites.** Normal dockerd builds a bridge and programs NAT with iptables — impossible without CAP_NET_ADMIN, hence `--iptables=false`. Rootless Docker's own outbound path historically ran through **slirp4netns** (usermode TCP/IP for the rootlesskit namespace); Docker 29 switched the default rootless network driver to **gvisor-tap-vsock** and stopped shipping slirp4netns ([Docker 29 release notes](https://docs.docker.com/engine/release-notes/29/)). Either way, with iptables off there is no per-container bridge network, so inner containers must join the "host" network — which is the rootless daemon's namespace, sharing the outer sandbox's network stack ([DinD guide](https://developers.cloudflare.com/sandbox/guides/docker-in-docker/), [security model](https://developers.cloudflare.com/sandbox/concepts/security/)).
- **What host networking means for jobs:** inner containers, the runner, and dockerd may share one network namespace. Port collisions and lack of network isolation are expected. A CLI wrapper that injects `--network=host` may cover direct `docker build`/`run`, but the Actions runner also creates networks for `container:` and `services:` jobs. The wrapper cannot make those semantics work by declaration; ticket 15 decides the exact supported surface.

**Base image consequence:** `docker:dind-rootless` (Cloudflare's suggested starting point for generic sandboxes) is **Alpine/musl** — putting the glibc-linked runner on it walks straight into the bundled-Node `fcntl64` failure the broker hit. Invert it: start from the glibc runner image and add the rootless docker engine, not the other way around.

## 5. The ICU fix, done properly

The broker-era bug is **already fixed upstream**: today's `installdependencies.sh` falls back through `libicu80 … libicu74 … libicu52`, so Ubuntu 24.04's `libicu74` is matched ([installdependencies.sh](https://github.com/actions/runner/blob/main/src/Misc/layoutbin/installdependencies.sh), [Ubuntu noble ICU source](https://launchpad.net/ubuntu/noble/+source/icu)). But running that script in a Dockerfile is the wrong shape anyway — it's a sudo-gated, network-probing installer. The clean options:

1. **Use the official image's trick:** `ghcr.io/actions/actions-runner` builds `FROM mcr.microsoft.com/dotnet/runtime-deps:8.0-noble` and never installs ICU at all, because the non-chiseled runtime-deps image already carries .NET's full native dependency set including globalization libs ([images/Dockerfile](https://github.com/actions/runner/blob/main/images/Dockerfile); [.NET container images docs](https://learn.microsoft.com/en-us/dotnet/core/docker/container-images) — only the chiseled/distroless variants drop ICU).
2. On a plain `ubuntu:24.04` base: `apt-get install -y libicu74 liblttng-ust1t64 libkrb5-3 zlib1g libssl3t64` — the exact set the installer script resolves to on noble, pinned explicitly.

**Recommendation: option 1 — base Jitney's image on `ghcr.io/actions/actions-runner`.** It is GitHub's maintained Ubuntu 24.04/glibc layout with the native dependency set, runner user, Docker CLI/buildx, `RUNNER_MANUALLY_TRAP_SIG=1`, and log-to-stdout behavior already handled ([images/Dockerfile](https://github.com/actions/runner/blob/main/images/Dockerfile)). Jitney adds tini, its supervisor, maintained Node LTS and Python 3 installations, and rootless-engine bits only in the Docker flavor. Runner, Node, Python, and Docker versions need automated update checks and compatibility tests. The GHCR image is a build source; the derived image is published to Cloudflare's registry per §2.

## 6. Recommended Dockerfile skeleton

This shows the Docker flavor because it has the superset of Linux dependencies. The plain flavor omits the rootless-engine download, uidmap ranges, and Docker-only runtime setup.

```dockerfile
# Jitney runner image — Ubuntu 24.04 (noble) via GitHub's maintained runner layout.
# Pin the tag; runner version bumps are FROM-line changes.
FROM ghcr.io/actions/actions-runner:2.3XX.X

USER root

# tini: PID 1 reaper + signal forwarder.
# uidmap: newuidmap/newgidmap for the rootless userns.
# fuse-overlayfs: storage fallback if unprivileged kernel overlayfs is unavailable.
# iproute2/dbus-user-session: rootlesskit runtime deps.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tini uidmap fuse-overlayfs iproute2 dbus-user-session \
    && rm -rf /var/lib/apt/lists/*

# Rootless docker engine (dockerd + rootlesskit); the base image already has
# the docker CLI and buildx. Layer kept separate from the runner layer so
# engine and runner bump independently.
ARG DOCKER_VERSION=XX.X.X
RUN curl -fLo /tmp/rootless.tgz \
      "https://download.docker.com/linux/static/stable/x86_64/docker-rootless-extras-${DOCKER_VERSION}.tgz" \
    && curl -fLo /tmp/engine.tgz \
      "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz" \
    && tar -xzf /tmp/rootless.tgz -C /usr/local/bin --strip-components=1 \
    && tar -xzf /tmp/engine.tgz  -C /usr/local/bin --strip-components=1 dockerd docker-proxy containerd containerd-shim-runc-v2 runc \
    && rm /tmp/*.tgz

# Subordinate uid/gid ranges for the rootless userns — no host admin exists
# to create these at runtime.
RUN echo "runner:100000:65536" >> /etc/subuid \
    && echo "runner:100000:65536" >> /etc/subgid

COPY jitney-supervisor /usr/local/bin/jitney-supervisor

USER runner
ENV XDG_RUNTIME_DIR=/home/runner/.run
# RUNNER_MANUALLY_TRAP_SIG=1 and ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT=1
# are inherited from the base image.

# tini is PID 1 and subreaps; the supervisor owns process groups and escalation.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/jitney-supervisor"]
```

The supervisor is a deliberately small program or rigorously tested script, not a pass-through entrypoint. Its interface is environment/configuration at startup and process exit status. Its implementation must:

- copy the JIT bootstrap into local memory and remove the environment copy before launching descendants;
- start optional rootless dockerd and prove readiness before the runner for Docker flavors;
- launch `run.sh --jitconfig <value>` as a new session leader, outside the supervisor's own session;
- on SIGTERM, signal all processes in that session (including the helper's separate process group), wait the configured grace, enumerate again, then SIGKILL survivors;
- stop dockerd, reap all children, and return a classified exit reason without printing secrets.

The JIT value may remain observable in a same-UID process argument while the listener uses it. Ticket 14 tests the actual exposure and confirms that the consumed single-use value cannot grant control-plane access.

## 7. Process-supervision sketch

```
PID 1  tini                              subreaps orphaned descendants
  └── jitney-supervisor                 owns grace timer, exit reason, and cleanup
        ├── runner session (may contain several process groups)
        │     └── run.sh → run-helper → Listener → Worker → job steps
        └── dockerd-rootless (Docker flavor only)

normal end          : listener exits → supervisor stops dockerd → exits
early control stop  : TERM → runner-session INT → measured grace → KILL survivors
assignment deadline : scheduler stops an online but unassigned runner after minutes
runtime deadline    : scheduler stops the runner after its separate job-time ceiling
platform backstop   : Cloudflare sends KILL after 15 minutes if all else fails
```

## Open items for the spikes and measurements

- Ticket 14: prove signal propagation, timed escalation, zombie reaping, OOM/restart behavior, and JIT bootstrap containment.
- Ticket 15: confirm rootless Docker storage, buildx, host networking, disk behavior, job containers, service containers, daemon startup, and shutdown on Cloudflare.
- Ticket 18: compare Podman CLI alias, API service, and native runner hooks against that Docker control, including kernel-facing behavior and cleanup.
- Ticket 9: measure end-to-end startup, image size, resource peaks, and cost for both candidate default sizes.
- Decide from measurements whether Docker is a second image or a gated feature in one image; separate images keep the plain image smaller.

## Sources

- Cloudflare Containers — lifecycle/architecture: https://developers.cloudflare.com/containers/platform-details/architecture/
- Cloudflare Containers — placement/prefetch: https://developers.cloudflare.com/containers/platform-details/placement/
- Cloudflare Containers — image management/registry: https://developers.cloudflare.com/containers/platform-details/image-management/
- Cloudflare Containers — limits and instance types: https://developers.cloudflare.com/containers/platform-details/limits/
- Cloudflare Containers — container class (ephemeral disk): https://developers.cloudflare.com/containers/container-class/
- Cloudflare Containers — FAQ: https://developers.cloudflare.com/containers/faq/
- Cloudflare Sandbox SDK — Docker-in-Docker guide: https://developers.cloudflare.com/sandbox/guides/docker-in-docker/
- Cloudflare Sandbox SDK — security model: https://developers.cloudflare.com/sandbox/concepts/security/
- actions/runner — official image Dockerfile: https://github.com/actions/runner/blob/main/images/Dockerfile
- actions/runner — run.sh (signal trap modes): https://github.com/actions/runner/blob/main/src/Misc/layoutroot/run.sh
- actions/runner — run-helper.sh.template (exit codes, docker wait): https://github.com/actions/runner/blob/main/src/Misc/layoutroot/run-helper.sh.template
- actions/runner — installdependencies.sh (libicu fallback list): https://github.com/actions/runner/blob/main/src/Misc/layoutbin/installdependencies.sh
- actions/runner — graceful shutdown via SIGINT: https://github.com/actions/runner/issues/2190
- GitHub Docs — JIT runners run a single job, auto-removed: https://docs.github.com/en/actions/reference/security/secure-use
- krallin/tini — reaping, signal forwarding, `-g`: https://github.com/krallin/tini
- Docker — rootless mode (uidmap, userns): https://docs.docker.com/engine/security/rootless/
- Docker — storage drivers (rootless overlay2 ≥5.11, fuse-overlayfs fallback): https://docs.docker.com/engine/storage/drivers/select-storage-driver/
- Docker — Engine 29 release notes (gvisor-tap-vsock replaces slirp4netns): https://docs.docker.com/engine/release-notes/29/
- .NET container images (ICU in runtime-deps variants): https://learn.microsoft.com/en-us/dotnet/core/docker/container-images
- Ubuntu noble ICU packaging (libicu74): https://launchpad.net/ubuntu/noble/+source/icu
