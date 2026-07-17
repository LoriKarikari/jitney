---
title: Specify transactional repair and complete destroy
labels: [wayfinder:grilling]
status: open
assignee:
blocked-by:
  - 03-deployment-receipt-and-drift
---

## Question

What are the states, transitions, deletion order, compensation limits, and resumability guarantees for repair and complete destruction? Cover explicit expired-lease recovery, drift reconciliation, one-time GitHub App self-revocation with browser fallback, removal of every independently removable Cloudflare resource, safe image-reference pruning, optional redacted export, and continuation after partial teardown. Define idempotency, error precedence, receipt retention, strong proof that each resource is gone, and the terminal conditions for success, residue, and manual intervention. Use `/domain-modeling` and `/grilling`; record an implementation-ready state model in the resolution.
