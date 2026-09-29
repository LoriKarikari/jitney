# Could rootless Podman replace rootless Docker for Jitney?

**Date:** 2026-07-11
**Scope:** An ephemeral GitHub Actions runner inside an unprivileged Cloudflare Container. Primary sources only.

## Executive conclusion

**Not as a drop-in replacement yet.** Rootless Podman is a credible engine for Jitney’s own `build`/`run` commands, and its Docker-compatible socket should satisfy many ordinary Docker clients. Neither fact proves that GitHub Actions job containers (`container:`) and service containers (`services:`) work unchanged.

The runner’s native path invokes a binary literally named `docker`, creates a user-defined network, attaches job and service containers, assigns service aliases, inspects/execs them, and removes and prunes them. That network path is where Cloudflare’s prohibition on iptables and Podman’s rootless networking split create the largest risk. Podman’s default `pasta` works without capabilities, but its rootless documentation describes separate network behavior and inter-container caveats. A 2024 Podman 5.3 development issue records a Netavark/iptables failure for pre-created Compose networks; it is a historical test case, not evidence about the current release. [Runner command manager](https://github.com/actions/runner/blob/main/src/Runner.Worker/Container/DockerCommandManager.cs) · [Cloudflare FAQ](https://developers.cloudflare.com/containers/faq/) · [Podman rootless notes](https://github.com/containers/podman/blob/main/rootless.md) · [Podman issue #24285](https://github.com/containers/podman/issues/24285)

**Recommendation:** retain Cloudflare’s documented `docker:dind-rootless` route as the compatibility baseline. Prototype Podman behind an engine option. Of the three integration modes, test the CLI alias first, use the API service only for Docker API consumers, and treat a native Podman container-hook adapter as a promising but separately maintained **public-preview** backend—not a stable drop-in. Promote only after the Cloudflare experiment matrix passes, especially service DNS, port publication, cancellation, and cleanup. Use Buildah only as a build-only option.

**Confidence:** **high** that Podman can do basic rootless build/run on a suitable kernel; **medium** that its socket handles common Docker clients; **low-to-medium** that native Actions `container:`/`services:` work unchanged in Cloudflare; **medium** that hooks can implement the needed semantics, but **high** that adopting them adds preview-API and adapter maintenance risk. Cloudflare does not publish enough low-level runtime detail to decide this without experiments.

## Three compatibility claims that must not be conflated

| Claim | Assessment | Why |
|---|---|---|
| **1. Podman CLI can build/run** | **Likely, conditional** | Podman is daemonless and rootless by design. It still needs nested user namespaces and usable ID mappings; storage must resolve to native overlay, `fuse-overlayfs`, or slow `vfs`; networking needs `pasta`/`slirp4netns` or host networking. [Podman manual](https://docs.podman.io/en/latest/markdown/podman.1.html) |
| **2. Docker-compatible socket works for Docker clients** | **Likely for common calls, not an equivalence guarantee** | `podman system service` exposes a Docker compatibility API on a rootless Unix socket. Its documentation does not promise every Docker behavior or extension. Socket access grants full Podman control as that user. [Podman system service](https://docs.podman.io/en/latest/markdown/podman-system-service.1.html) |
| **3. Actions `container:` and `services:` work unchanged** | **Unproven and highest risk** | The runner resolves `docker`, checks formatted client/server API versions, and shells out to network/create/alias/port/inspect/exec/cleanup operations. Podman CLI compatibility plus a socket does not prove equivalent DNS, networking, or output. [DockerCommandManager.cs](https://github.com/actions/runner/blob/main/src/Runner.Worker/Container/DockerCommandManager.cs) |

## Three integration modes

### A. A `docker` → `podman` CLI alias or wrapper

This most closely matches the stock runner because `DockerCommandManager.Initialize` uses `which docker` and subsequently executes that path. The runner uses `version --format`, `pull`, `build`, `create`, `start`, `run`, `logs --details`, `ps`, `network create/rm/prune`, `exec`, `inspect`, `port`, `login`, and forced removal, with labels, named networks, aliases, mounts, ports, environment and entrypoint options. [DockerCommandManager.cs](https://github.com/actions/runner/blob/main/src/Runner.Worker/Container/DockerCommandManager.cs)

**Advantages:** no engine daemon; smallest integration; the runner retains its normal orchestration and cleanup. **Risks:** any CLI/output mismatch is exposed; most importantly, the runner-created named network may select a Netavark path that needs firewall support. This mode is the only plausible meaning of “work unchanged,” and it is unproven.

### B. Docker CLI/client → `podman system service`

The service supplies Docker-compatible and Libpod APIs and can bind a rootless Unix socket. A real Docker CLI pointed at it may improve CLI formatting compatibility and is necessary for workflow tools that directly use Docker SDKs. [Podman system service](https://docs.podman.io/en/latest/markdown/podman-system-service.1.html)

**Advantages:** accommodates API clients; can use socket activation or an inactivity timeout. **Risks:** reintroduces a supervised service and cold-start/readiness concerns; API compatibility still does not guarantee Docker networking semantics; the stock runner still requires a `docker` executable. In a systemd-less Cloudflare image, Jitney must own startup, socket permissions, health checks, restart, shutdown and child reaping.

### C. Native Podman runner container-hook adapter

GitHub officially documents container customization for self-hosted runners and explicitly gives **Podman** as an example. A hook script receives four commands: `prepare_job`, `cleanup_job`, `run_container_step`, and `run_script_step`. `prepare_job` must create the job/service environment, wait for readiness, write state/context (including `isAlpine`), and return it through the response file; cleanup receives the saved state. The two run-step commands must reproduce mounts, environment, entrypoint/arguments, working directory, exit status and output behavior. [GitHub container customization docs](https://docs.github.com/actions/hosting-your-own-runners/customizing-the-containers-used-by-jobs) · [ADR 1891](https://github.com/actions/runner/blob/main/docs/adrs/1891-container-hooks.md)

The official [`actions/runner-container-hooks`](https://github.com/actions/runner-container-hooks) repository provides Docker and Kubernetes implementations as examples/guides, not a Podman implementation. Its Docker hooks intentionally mirror the runner’s built-in Docker behavior and still require Docker. The repository’s recent releases show active maintenance, but that does not stabilize the protocol. [Docker hooks README](https://github.com/actions/runner-container-hooks/tree/main/packages/docker) · [releases](https://github.com/actions/runner-container-hooks/releases)

**Support/stability verdict:** hooks are real, documented and usable, but GitHub’s current documentation labels container customization **public preview and subject to change**. A Jitney Podman adapter would therefore be production code that Jitney owns against a preview contract. Pin the runner and hook schema, contract-test all four commands, and expect update work. Do not call it an officially supplied Podman backend.

**Why hooks may be the best Cloudflare-specific route:** they can intentionally avoid the stock named bridge. `prepare_job` could run all siblings with host networking, allocate collision-free host ports, inject deterministic service-name entries or another userspace DNS mechanism, perform service health checks, and report mappings through job context. It can also track every Podman container/helper in hook state for exact cleanup. This flexibility directly addresses no iptables/`CAP_NET_ADMIN`/TUN.

**Why hooks do not make networking easy:** Actions normally expects container actions to run as sibling containers on the same network and job containers to resolve services by label. [Running jobs in a container](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/run-jobs-in-a-container) A host-network adapter must reproduce name resolution, port semantics, isolation and collision handling. `/etc/hosts` injection must account for startup order and both job and container-action siblings. Concurrent jobs in one VM would make host ports and names harder; Jitney’s one ephemeral runner/job model helps but must be enforced. Hooks also expand the trusted code and test surface versus an alias.

**Mode ranking:** alias is simplest and should be tried first; the socket is an add-on for API compatibility, not a fix for networking; hooks are the strongest fallback for Cloudflare constraints but should remain opt-in until the preview contract and full behavior matrix are acceptable.

## What Cloudflare guarantees—and what it does not

Cloudflare says each instance runs in its own VM, is `linux/amd64`, has ephemeral local disk tied to instance size, and may stop after inactivity. Sizes span 256 MiB/2 GB disk through 12 GiB/20 GB disk. This favors little idle state and makes layer duplication material. [Architecture](https://developers.cloudflare.com/containers/platform-details/architecture/) · [limits](https://developers.cloudflare.com/containers/platform-details/limits/)

The Containers FAQ says instances run without root privileges, directs users to `docker:dind-rootless`, and requires `--iptables=false --ip6tables=false` because iptables manipulation is unsupported. Cloudflare's separate Sandbox DinD guide requires `--network=host` when an inner container must send or receive network traffic; a purely local build does not need that claim generalized to every nested operation. [Cloudflare FAQ](https://developers.cloudflare.com/containers/faq/) · [Sandbox DinD guide](https://developers.cloudflare.com/sandbox/guides/docker-in-docker/)

That proves Cloudflare intentionally supports at least one nested-rootless setup. It does **not** document kernel version, nested user-namespace depth, subordinate ID maps, helper permissions, cgroup delegation, native unprivileged OverlayFS, arbitrary `/dev/fuse`, `/dev/net/tun`, or allowed seccomp syscalls. Cloudflare’s R2 FUSE example is not proof that arbitrary images receive `/dev/fuse` for `fuse-overlayfs`. [R2 FUSE example](https://developers.cloudflare.com/containers/examples/r2-fuse-mount/)

## Kernel, storage, and network analysis

### Nested rootless user namespaces and cgroups

Rootless Podman creates a user namespace and normally maps subordinate IDs using `/etc/subuid`, `/etc/subgid`, `newuidmap`, and `newgidmap`. A single-ID mapping can work but causes ownership failures for multi-UID images. [Rootless tutorial](https://github.com/containers/podman/blob/main/docs/tutorials/rootless_tutorial.md) Rootless Docker has essentially the same prerequisite. [Docker rootless mode](https://docs.docker.com/engine/security/rootless/) Podman does not eliminate it.

Rootless resource controls depend on cgroup v2 and delegation; otherwise execution may work with degraded per-container limits. Docker documents rootless cgroup support only with cgroup v2 plus systemd. [Docker troubleshooting](https://docs.docker.com/engine/security/rootless/troubleshoot/) Cloudflare documents neither. VM-level limits help, but workflow-requested limits and OOM attribution may not.

### Storage

`containers/storage` lists `overlay`, `btrfs`, and `vfs` as rootless drivers and supports `mount_program` (normally `fuse-overlayfs`). [Storage configuration](https://github.com/containers/storage/blob/main/docs/containers-storage.conf.5.md)

Preferred experiment order: **native rootless overlay** for likely best performance; **fuse-overlayfs** if FUSE is available; **vfs** only as a portability control, because layer copying is likely too slow and space-heavy on 2–20 GB disks. Docker rootless supports the analogous set with kernel constraints. [Docker troubleshooting](https://docs.docker.com/engine/security/rootless/troubleshoot/) Neither engine solves nested overlay-on-overlay or absent FUSE automatically.

### Networking without iptables, `CAP_NET_ADMIN`, or TUN

Podman 5 defaults rootless networking to **pasta**. Podman says unprivileged users cannot create host interfaces, a userspace tool is required, and pasta works without privileges/capabilities. [Basic networking](https://github.com/containers/podman/blob/main/docs/tutorials/basic_networking.md) · [rootless tutorial](https://github.com/containers/podman/blob/main/docs/tutorials/rootless_tutorial.md) This fits Cloudflare and normally does not need TUN.

Multi-container topology is the problem. Podman’s rootless notes say pasta copies the main interface address and inter-container connections require explicit configuration. [Rootless notes](https://github.com/containers/podman/blob/main/rootless.md) The stock runner creates a named network and uses `--network-alias`. A historical Podman 5.3 development issue shows one pre-created/Compose network path reaching Netavark and failing without iptables. It supplies a regression test to reproduce on the pinned current version, not a current-behavior conclusion. [Podman #24285](https://github.com/containers/podman/issues/24285)

Cloudflare’s `--network=host` workaround is likely simplest, but stock Actions service aliases are not recreated automatically and host ports may collide. Hooks can implement the translation, at the cost described above.

## Lifecycle, startup, cleanup, and security

Podman’s CLI is daemonless, reducing idle RSS and removing dockerd startup for CLI-only use. Each operation still launches conmon/runtime/network/storage helpers, and pulls dominate cold starts. [Podman manual](https://docs.podman.io/en/latest/markdown/podman.1.html)

The API mode uses a persistent or socket-activated `podman system service`; without systemd Jitney must supervise it, create a stable runtime directory/socket, detect failure, and terminate it. [Podman system service](https://docs.podman.io/en/latest/markdown/podman-system-service.1.html) Rootless dockerd likewise needs supervision via `dockerd-rootless.sh` without systemd. [Docker rootless tips](https://docs.docker.com/engine/security/rootless/tips/)

On shutdown, stop the runner, invoke hook cleanup if applicable, `podman rm -af`, prune tracked networks, and kill/wait for API and helper processes. Test that conmon, pasta/slirp, fuse-overlayfs and runtimes do not survive cancellation. The hook adapter should persist exact IDs in hook state rather than rely only on global pruning.

Both engines map nested root to an unprivileged outer UID. Podman’s daemonless mode narrows idle attack surface. Its API socket grants full same-user control: keep it `0600`, never expose it over TCP, and remove it at shutdown. A malicious job already running as the runner UID can control either rootless engine and consume VM resources; rootless is not a boundary between a job and a same-UID Jitney supervisor. [Podman system service](https://docs.podman.io/en/latest/markdown/podman-system-service.1.html)

## Buildx, Compose, image footprint, and Buildah

`podman buildx build` is an alias for `podman build`; Podman warns not all Buildx features exist. [Podman build](https://docs.podman.io/en/stable/markdown/podman-build.1.html) `podman compose` delegates to an external `docker-compose` or `podman-compose` provider, and its networks remain a no-iptables risk. [Podman compose](https://docs.podman.io/en/stable/markdown/podman-compose.1.html)

Podman can omit dockerd/rootlesskit in CLI-only mode, but a capable bundle still needs Podman, OCI runtime, conmon, containers-common/storage, Netavark/Aardvark, pasta, perhaps slirp4netns/fuse-overlayfs, and optionally Compose. Numeric savings require building both Jitney variants and measuring compressed/unpacked image, pulled layers, disk and RSS.

Buildah shares storage and namespace constraints. Its rootless isolation can help constrained builds, but it provides neither Docker’s service API nor Actions’ service lifecycle/network model. Use it only for a build-only mode. [Buildah manual](https://github.com/containers/buildah/blob/main/docs/buildah.1.md)

| Property | Rootless Podman | Rootless dockerd | Buildah |
|---|---|---|---|
| Basic build/run | Yes, conditional | Yes; Cloudflare documents route | Build-focused |
| Persistent daemon | No for CLI; yes for API service | Yes | No |
| Stock runner integration | Alias possible; semantics unproven | Canonical path | No |
| Docker API | Compatibility layer | Canonical | No |
| Custom hook backend | Must be built/maintained; preview API | Official example mirrors Docker | Not general engine |
| Multi-container services | Primary unresolved Cloudflare risk | Existing baseline/workaround | Unsuitable |
| Buildx/Compose | Partial/external | Canonical ecosystem | Not applicable |

## Concrete Cloudflare experiment matrix

Run each row in a real Cloudflare Container. Pin image digest, engine versions, runner commit and hook adapter commit.

| Axis | Variants | Pass condition / evidence |
|---|---|---|
| Integration | alias; Docker CLI + Podman socket; native Podman hooks; rootless Docker control | Separately report results—never infer one mode from another. |
| Hook contract | all four commands; missing/invalid response; timeout; runner upgrade | `prepare_job` returns context/state and service readiness; both step types preserve mounts/env/workdir/entrypoint/output/exit/cancellation; cleanup is idempotent. Contract tests use official example payloads. |
| Namespace | Podman and Docker control | Record kernel, UID/GID maps, subordinate files/helpers; multi-UID image writes succeed. |
| cgroups | engine × CPU/memory requests | Record controllers/delegation; limits demonstrably enforce or are explicitly unsupported. |
| Storage | native overlay; fuse-overlayfs; vfs | Confirm—not infer—driver; pull/build/run/remove. Measure cold/warm time, disk, inodes and leftovers; no silent production vfs fallback. |
| Simple network | pasta; slirp if packaged; host | DNS/registry/GitHub IPv4/IPv6 egress; high-port ingress where expected; no iptables/TUN/capability dependency. |
| Service topology | named network; hook host-network translation | Job resolves `postgres`, health check passes, ports map correctly. Include two services, duplicate internal ports, container actions, and one service contacted from host and job container. |
| Concurrency | one job/VM; forced two-job adversarial test | No alias or host-port collision; if only one is supported, enforce and document it. |
| API | service timeout zero/finite; service crash/restart | Docker client performs version, pull, create/start/inspect/exec/logs/port/rm/network operations; socket permissions/readiness/recreation pass. |
| Private registries | CLI alias; API socket; hooks; job container; service; container action | Authenticated pull and push work in every mode; hook-provided registry credentials are scoped, redacted from logs, removed during cleanup, and absent from later steps. |
| Actions corpus | host job; `container:`; `services:`; `docker://`; Dockerfile action | Mounts, env, workdir, entrypoint, exec, logs, inspect, health, ports and cancellation match baseline. |
| Builds | multi-stage; secrets/SSH; cache/export; multi-platform; Buildx; Compose | Exact unsupported features classified; no parity claim from simple build. |
| Lifecycle | success; SIGTERM during pull/build/run; runner/hook/API crash; sleep/wake | No stale names, networks, mounts, socket or helpers; cleanup idempotent; next job succeeds. |
| Capacity/security | smallest and target size; malicious same-UID job | Measure image/cold-start/RSS/disk. Socket `0600`, no TCP listener, mapped IDs unprivileged, secrets exposure reviewed. |

**Promotion gate:** the Jitney workflow corpus passes 30 consecutive ephemeral starts; service DNS/ports pass; cancellation leaves zero helpers; production never silently uses vfs; p95 readiness and footprint materially improve; unsupported Buildx/Compose is surfaced; and the pinned hooks adapter passes contract tests against the chosen runner. A hooks backend must be labeled experimental while GitHub labels the API public preview.

## Final recommendation and unresolved facts

1. **Production:** keep rootless Docker as Cloudflare’s documented path and compatibility baseline.
2. **Prototype alias first:** it is the lowest-cost test of unchanged Actions behavior. If named networking fails, do not paper over it.
3. **Add the socket only when needed:** it serves API consumers; it is not a networking fix.
4. **Prototype hooks second:** a Podman adapter can deliberately implement host-network service discovery and cleanup, and is likely the most controllable Cloudflare solution. Ship only opt-in while the API is public preview; pin runner/schema and own the adapter’s tests and updates.
5. **Buildah:** reserve for build-only workloads.

Still unresolved: Cloudflare kernel/config and nested namespace depth; subordinate mappings/helper permissions; cgroup v2 delegation/systemd; native overlay/backing filesystem and arbitrary FUSE access; seccomp and TUN; Netavark/Aardvark named networks without firewall access; termination grace/sleep semantics; actual size/RSS/cold-start deltas; exact runner CLI/API formatting; and whether the hook-based host-network design can reproduce service DNS/ports for Jitney’s full workflow corpus.

## Primary sources kept

* [Cloudflare FAQ](https://developers.cloudflare.com/containers/faq/) and [Sandbox DinD guide](https://developers.cloudflare.com/sandbox/guides/docker-in-docker/) — rootless DinD, no iptables, and the host-network workaround.
* [Cloudflare architecture](https://developers.cloudflare.com/containers/platform-details/architecture/) and [limits](https://developers.cloudflare.com/containers/platform-details/limits/) — VM/lifecycle/resources.
* [GitHub container customization docs](https://docs.github.com/actions/hosting-your-own-runners/customizing-the-containers-used-by-jobs) — official commands, Podman example, and public-preview status.
* [Runner ADR 1891](https://github.com/actions/runner/blob/main/docs/adrs/1891-container-hooks.md), [DockerCommandManager](https://github.com/actions/runner/blob/main/src/Runner.Worker/Container/DockerCommandManager.cs), and [ContainerOperationProvider](https://github.com/actions/runner/blob/main/src/Runner.Worker/ContainerOperationProvider.cs) — integration contracts.
* [Official runner-container-hooks repository](https://github.com/actions/runner-container-hooks) and [Docker example](https://github.com/actions/runner-container-hooks/tree/main/packages/docker) — implementation reference and evidence no official Podman adapter is supplied.
* [Podman manual](https://docs.podman.io/en/latest/markdown/podman.1.html), [rootless tutorial](https://github.com/containers/podman/blob/main/docs/tutorials/rootless_tutorial.md), [rootless notes](https://github.com/containers/podman/blob/main/rootless.md), and [system service](https://docs.podman.io/en/latest/markdown/podman-system-service.1.html) — prerequisites, networking and API.
* [containers/storage configuration](https://github.com/containers/storage/blob/main/docs/containers-storage.conf.5.md) — storage drivers.
* [Docker rootless docs](https://docs.docker.com/engine/security/rootless/) and [troubleshooting](https://docs.docker.com/engine/security/rootless/troubleshoot/) — canonical comparison.
* [Podman build](https://docs.podman.io/en/stable/markdown/podman-build.1.html), [compose](https://docs.podman.io/en/stable/markdown/podman-compose.1.html), [issue #24285](https://github.com/containers/podman/issues/24285), and [Buildah manual](https://github.com/containers/buildah/blob/main/docs/buildah.1.md) — documented compatibility limits and a historical regression case to retest.

Repository sources were checked at these commits so the evidence can be recovered if `main` moves:

| Repository | Commit |
|---|---|
| `actions/runner` | `8efad23e6e87e8494afd6ac6c73d68cb35cacdb4` |
| `actions/runner-container-hooks` | `cf62bccba0d59addaf08a115f96ebcd81fb499d8` |
| `containers/podman` | `ac46410007edf94c9c5482c5d83c1471cfd23b00` |
| `containers/storage` | `83cf57466529353aced8f1803f2302698e0b5cb7` |
| `containers/buildah` | `e4b285a365f3f15b6050932524744216b003d986` |

No secondary commentary or SEO sources were used. Duplicate manuals and unrelated network pages were dropped.
