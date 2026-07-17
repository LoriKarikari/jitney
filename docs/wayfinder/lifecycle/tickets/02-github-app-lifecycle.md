---
title: Determine GitHub App teardown and repository ownership controls
labels: [wayfinder:research]
status: open
assignee:
blocked-by: []
---

## Question

What is the safest GitHub-supported path for a Jitney deployment to delete its own App and installations, verify their removal, and recover when its credentials or owner permissions are unavailable? Evaluate App-JWT self-deletion, one-time uninstall authorization at the Worker, browser fallback, organization-owned Apps, revoked credentials, and partial deletion. Also determine how installation can detect and reject repositories already owned by another Jitney deployment using the minimum additional GitHub permission. Produce an API and threat-model summary as a linked asset.
