---
title: Specify transactional install, upgrade, and rollback
labels: [wayfinder:grilling]
status: open
assignee:
blocked-by:
  - 03-deployment-receipt-and-drift
---

## Question

What are the states, transitions, ordering rules, compensation actions, and resumability guarantees for deployment-changing operations? Cover automatic install rollback with `--keep-partial`, in-place upgrade with no lost jobs, health verification and automatic rollback, explicit N-1 rollback, and current-plus-previous image retention. Define lease acquisition, crash recovery, idempotency keys, migration compatibility, error precedence, and the exact terminal conditions for success and manual intervention. Use `/domain-modeling` and `/grilling`; record an implementation-ready state model in the resolution.
