---
title: Determine Cloudflare resource ownership and deletion semantics
labels: [wayfinder:research]
status: open
assignee:
blocked-by: []
---

## Question

Which Cloudflare resources does each named Jitney deployment create, how are they related, and which APIs can reliably inventory, update, roll back, and delete them? Establish the observed behavior for Workers, Durable Object state, container applications, running instances, secrets, copied registry tags, shared image blobs, routes, and cron triggers. In particular, determine why deleting a Worker does not delete its container application, what ordering avoids conflicts, how to prove deletion, and how to prune only image tags unreferenced by any deployment. Produce an evidence-backed resource graph and lifecycle capability matrix as a linked asset.
