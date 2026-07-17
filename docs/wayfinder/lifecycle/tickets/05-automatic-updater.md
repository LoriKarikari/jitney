---
title: Find a least-privilege substrate for opt-in automatic upgrades
labels: [wayfinder:research]
status: open
assignee:
blocked-by: []
---

## Question

Can a self-hosted Jitney deployment perform unattended `patch` or `latest` channel upgrades without storing an account-wide Cloudflare deployment credential in the Worker or depending on a managed Jitney service? Investigate Cloudflare token scoping, service bindings and deployment APIs, Workers Builds or other native mechanisms, user-owned scheduled GitHub Actions, registry synchronization, credential rotation, and revocation. Compare blast radius and onboarding cost. If no acceptable mechanism exists, state that clearly and define what upstream capability would change the verdict. Produce a recommendation with primary-source evidence as a linked asset.
