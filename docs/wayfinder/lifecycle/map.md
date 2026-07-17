---
labels: [wayfinder:map]
---

# Map: Specify the Jitney deployment lifecycle

## Destination

A handoff-ready specification for Jitney's install, upgrade, rollback, repair, and uninstall lifecycle. The map is done when resource ownership, state transitions, safety guarantees, command behavior, and proof requirements are settled well enough to implement without reopening product decisions.

## Notes

- This is a planning map. Implementation begins as a separate body of work.
- Multiple named Jitney deployments may share one Cloudflare account, but a repository belongs to exactly one Jitney deployment.
- Lifecycle state is cloud-side and contains no credentials; commands must work from a different machine. Discovery repairs state but must not claim resources based only on broad naming patterns.
- Installation rolls back partial work by default. `--keep-partial` exists for diagnosis.
- Upgrades preserve Worker and GitHub App identity, lose no queued jobs, retain current plus previous versions, and guarantee N-1 rollback compatibility.
- Automatic upgrades are opt-in (`patch` or `latest`, with `patch` recommended), but may not require an account-wide Cloudflare credential inside Jitney.
- Uninstall promises complete reversal. It attempts GitHub App self-revocation with browser fallback, removes all independently removable resources after a failure, remains resumable, and reports residue instead of claiming false success.
- Mutating commands use an expiring cloud-side lease. Destruction requires an explicit deployment name and interactive inventory confirmation, with `--dry-run` and non-interactive `--yes` modes.
- Optional destruction export contains redacted lifecycle metadata, followed by immediate state deletion.
- Proof includes deterministic contract tests plus a weekly real-account smoke test. Lifecycle-changing releases must pass the live install, job, upgrade, rollback, job, destroy, baseline-restoration sequence.
- Tickets live in `tickets/`. Blocking is recorded via `blocked-by` in frontmatter. Claim a ticket by setting `assignee` before working it.
- Consult `/research`, `/grilling`, `/domain-modeling`, and `/prototype` according to ticket type.

## Decisions so far

<!-- One line per closed ticket: gist + link. -->

## Not yet specified

- The exact Cloudflare primitive that stores the deployment receipt and lease; this depends on the Cloudflare resource-lifecycle investigation.
- The repository ownership marker and minimum GitHub App permission needed to prevent overlapping deployments; this depends on the GitHub App investigation.
- Whether a suitably scoped unattended updater exists. If not, the specification must mark automatic upgrades unavailable rather than weaken the security boundary.
- The redacted export schema and retention metadata; sharpen after the receipt model is settled.
- How N-1 migration compatibility is enforced in CI; sharpen after the transactional lifecycle is specified.

## Out of scope

- Implementing the lifecycle commands or Worker changes.
- A browser dashboard.
- Terraform or other infrastructure-as-code support.
- A managed Jitney SaaS control plane.
- More than one retained rollback version.
- Coordinating multiple Jitney deployments for the same repository; overlap is rejected instead.
- Strict zero-latency upgrades; the contract is no lost jobs, not no temporary delay.
