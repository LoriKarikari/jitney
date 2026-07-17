---
title: Define the deployment receipt, ownership model, and drift recovery
labels: [wayfinder:grilling]
status: open
assignee:
blocked-by:
  - 01-cloudflare-resource-lifecycle
  - 02-github-app-lifecycle
---

## Question

What non-secret cloud-side record gives every lifecycle command an authoritative, portable inventory of one named deployment without making local state authoritative? Define deployment identity, owned and shared resource references, GitHub App owner and slug, current and previous versions, repository ownership, operation lease, lifecycle phase, creation and update history, and redacted export fields. Define how discovery proves identity, how `list` reports drift, what `repair` may adopt or reconcile, and what evidence is strong enough for `destroy` to remove an orphan without risking unrelated resources. Use `/domain-modeling` and `/grilling`; record the resulting model and invariants in the resolution.
