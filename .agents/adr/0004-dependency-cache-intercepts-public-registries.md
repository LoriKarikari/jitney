# 4. The Dependency Cache intercepts HTTPS for public registries only

Status: accepted, 2026-09-29

## Context

Every shard of a test matrix repeats the same package and toolchain
downloads. The Dependency Cache serves them from the Deployment's R2 bucket.
Two choices shape it: how job traffic reaches the cache, and what the cache
may store.

## Decision

Outbound HTTPS from a Runner Container to a fixed list of public registry and
toolchain hosts goes through the Deployment's Worker. The Worker terminates
TLS with Cloudflare's per-instance CA, which the runner image trusts at boot.
It caches only immutable URLs requested without credentials, shares them
across the Deployment, and passes every authenticated request through
uncached. It never logs headers or bodies.

## Considered options

- **Registry mirrors set through environment variables**, such as
  `npm_config_registry` and `PIP_INDEX_URL`. This needs no interception and no
  CA. A workflow that sets its own registry, or a lockfile that pins registry
  hosts, bypasses or breaks it, and the cache has to work with no workflow
  changes.
- **Caching authenticated responses per repository.** Private packages would
  hit the cache. A URL-keyed cache shared across repositories would hand a
  private package to a repository without access, and per-repository scoping
  gives up the sharing that makes every shard's install fast.

## Consequences

- Registry tokens from jobs pass through Control Plane code. The usual rule
  that the Control Plane never enters the Data Plane still holds, but Data
  Plane traffic now enters the Control Plane.
- Each ecosystem needs its own trust setting: `NODE_EXTRA_CA_CERTS` for Node,
  `PIP_CERT` for pip, and a keystore import for Java.
- Private packages always download from their registry.
