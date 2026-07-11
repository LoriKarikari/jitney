# Workload compatibility

Live results from the private fixture repository, run on 2026-07-11 against
Worker version `0dca5e2c-2826-4c9c-b4de-8afb0853a345`. Each workflow used
`runs-on: jitney`, ran on a single-use JIT runner, and was dispatched
sequentially. This page records proven behavior, not assumptions derived from
the base image.

## Proven working

| Workload | Setup action | Requested | Resolved | Run | Job | Result |
| -------- | ------------ | --------- | -------- | --- | --- | ------ |
| Node.js (`npm install`, `node --test`) | `actions/setup-node@v6` | 24 | v24.18.0 | 29169374008 | 86587900983 | success |
| Python (`pip install`, `pytest`) | `actions/setup-python@v6` | 3.13 | 3.13.14 | 29169394006 | 86587954040 | success |
| Go (`go test ./...`) | `actions/setup-go@v6` | stable | go1.26.5 | 29169422890 | 86588027566 | success |
| Java (`javac` + `java`, Temurin) | `actions/setup-java@v5` | 21 | 21.0.11 | 29169452628 | 86588106460 | success |

Each job installed real dependencies from the public registry (semver via npm,
pytest and requests via pip) and ran a real test command. Every job completed
in under 90 seconds including runner provisioning.

## Proven not working

| Workload | Run | Job | Failure |
| -------- | --- | --- | ------- |
| Docker (`docker info`) | 29169474455 | 86588163491 | no daemon: `dial unix /var/run/docker.sock: connect: no such file or directory` |

The `docker` client binary exists in the base runner image, but no Docker
daemon runs inside the container. Workflows that build images, run
containerized steps, or use Docker-based actions will fail until Docker
support lands (see the product scope in `CONTEXT.md`: Docker labels are
conditional on a compatibility spike).

## Cleanup evidence

After all five runs completed:

- GitHub runner inventory returned to `total_count: 0`.
- The Cloudflare container application reported zero active and zero assigned
  instances.

## Not yet proven

- Workloads that assume `ubuntu-latest` package parity (preinstalled
  compilers, browsers, database servers).
- Rust, Ruby, .NET, and other ecosystems not listed above.
- Private registry access, caching actions, and artifact upload/download.
- Long-running jobs approaching the runtime deadline.

Fixture sources live in the private `jitney-test` repository under
`.github/workflows/` with one directory per ecosystem.
