---
title: Define lifecycle contract tests and live proof gates
labels: [wayfinder:grilling]
status: open
assignee:
blocked-by:
  - 01-cloudflare-resource-lifecycle
  - 02-github-app-lifecycle
  - 04-transactional-lifecycle
---

## Question

What automated evidence proves the lifecycle contract without making every pull request slow or flaky? Define deterministic unit and API-contract seams, fault injection for every compensation boundary, N-1 schema migration compatibility checks, and the dedicated-account live sequence: baseline inventory, install, real job, upgrade, real job, rollback, real job, destroy, and exact baseline restoration. Specify weekly scheduling, which lifecycle-changing releases are gated, credentials and approval boundaries, retry policy, residue alerts, cleanup after test harness failure, and evidence retention. Record the test matrix and release-gate policy in the resolution.
