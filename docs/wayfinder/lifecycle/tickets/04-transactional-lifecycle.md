---
title: Specify transactional install, upgrade, rollback, repair, and destroy
labels: [wayfinder:grilling]
status: open
assignee:
blocked-by:
  - 01-cloudflare-resource-lifecycle
  - 02-github-app-lifecycle
  - 03-deployment-receipt-and-drift
---

## Question

What are the states, transitions, ordering rules, compensation actions, and resumability guarantees for every mutating lifecycle operation? Cover automatic install rollback with `--keep-partial`, in-place upgrade with no lost jobs, health verification and automatic rollback, explicit N-1 rollback, drift repair, complete destroy with App self-revocation and browser fallback, image-reference pruning, optional redacted export, and continuation after partial teardown. Define the expiring operation lease, crash recovery, idempotency keys, error precedence, and the exact terminal conditions for success, residue, and manual intervention. Use `/domain-modeling` and `/grilling`; record an implementation-ready state model in the resolution.
