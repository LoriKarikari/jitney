# 2. Deployment receipts and operation leases

Status: accepted, 2026-07-20

## Context

Lifecycle commands run from arbitrary machines and can crash mid-operation.
Alchemy's state store is keyed per resource per stack/stage and recovers
per-resource crashes, but it has no cross-process lease, no deployment-level
phase, no cross-plane (Cloudflare + GitHub) inventory, and no ownership
proof that survives name recycling. Uninstall must prove complete reversal,
and two commands must never mutate one deployment at the same time.

## Decision

A shared, account-level `jitney-receipts` KV namespace holds one JSON
receipt per deployment, keyed by deployment name. The receipt (schema v1)
carries an immutable ULID minted at install, name, timestamps, lifecycle
phase, nullable lease, current/previous versions, Cloudflare and GitHub
resource blocks, auto-upgrade settings, and operation history capped at 20.
No secrets.

The lease is a receipt field `{operation, actor (user@host), expiresAt}`.
Acquisition is read → refuse on any recorded lease → write → read back to
detect the KV race. The TTL is 15 minutes, renewed by the running command,
and cleared together with the phase transition in one write. An expired
lease blocks every command until `repair` releases it.

The namespace is created on first deploy and deleted only when its last key
goes. Because KV key listing is eventually consistent, deletion waits one
minute and lists a second time before removing the namespace.

Receipts are a plain Effect service (`cli/src/receipts/`), not an Alchemy
resource: they are written before the stack deploys and deleted after the
stack is destroyed, outside the resource graph.

The Worker reads its own receipt for GitHub drift checks because App credentials
cannot be read back from Cloudflare secrets. Its lifecycle endpoint accepts the
deployment ULID held by the CLI and repository ownership variable, then returns
only classifications and receipt-relative indexes. It never returns repository
names, credentials, or receipt contents.

## Consequences

- Ownership always matches on the ULID, never the name. Recycled names get
  fresh ids, and a predecessor's leftovers surface as drift.
- KV gives no compare-and-swap, so the seconds-wide acquire race is
  accepted and detected by the read-back rather than prevented.
- A lease renewal interrupted between its write and its read-back leaves the
  stored `expiresAt` ahead of the command's copy. The next receipt write then
  fails ownership matching and the deployment waits for `repair`. The window
  is milliseconds wide and is accepted for the same no-CAS reason.
- `repair` is the only recovery path for expired leases; it marks the
  interrupted operation in history.
- Destroy deletes only what the receipt references; name-pattern deletion is
  structurally impossible.
