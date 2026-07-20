# 1. Alchemy v2 as the internal lifecycle resource engine

Status: accepted, 2026-07-20

## Context

Jitney's lifecycle commands (install, upgrade, rollback, repair, destroy)
need create, update, diff, and delete across Cloudflare resources (Worker,
Durable Objects, container application, KV) plus GitHub App metadata, with
crash recovery and adoption semantics. A hand-rolled resource engine was
built in PR #89 and abandoned before merge: it re-implemented planning,
state, and recovery badly, and every improvement moved it closer to an
existing tool.

## Decision

Adopt Alchemy v2 (Infrastructure-as-Effects) as the internal engine, invoked
programmatically from the CLI. Specifically:

- Pin the exact coupled beta set (`alchemy`, `effect`,
  `@effect/platform-node`) and upgrade them together on a tested branch.
- Use the generated `@distilled.cloud/cloudflare` SDK directly for CLI-side
  API calls Alchemy does not cover (KV values, listing). This is the same
  client Alchemy's own providers use internally; it ships with Alchemy, so
  declaring it directly costs no extra packages.
- Replace Alchemy's Docker-based remote image transfer with the existing
  Dockerless ORAS copy path.
- Keep the GitHub App as a custom provider, but keep App *deletion* outside
  the stack: it needs browser confirmation and residue verification, so the
  command owns that step.
- Alchemy is never user-facing. `npx get-jitney deploy` must not require
  users to author IaC or install Alchemy themselves.

## Consequences

- The CLI gains roughly 183 transitive packages. Accepted explicitly before
  merging PR #92.
- Alchemy and Effect are pre-GA; both are pinned exactly and Dependabot must
  not bump them independently.
- Alchemy state handles per-resource crash recovery. It has no cross-process
  deployment lease and no cross-plane deployment inventory, which is why ADR
  0002 exists.
- Custom providers follow Alchemy's documented contract, including an
  ownership-aware `read` returning `Unowned` for foreign resources.
