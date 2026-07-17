---
title: Prototype the lifecycle command experience
labels: [wayfinder:prototype]
status: open
assignee:
blocked-by:
  - 04-transactional-lifecycle
  - 09-transactional-repair-and-destroy
---

## Question

What should users see and do when running `list`, `upgrade <name>`, `rollback <name>`, `repair <name>`, and `destroy <name>`? Prototype terminal transcripts and JSON output for healthy, outdated, locked, drifted, partially upgraded, and partially destroyed deployments. Include explicit-name requirements, dry runs, typed destruction confirmation, `--yes`, browser-assisted App deletion, progress, interruption, residue reports, resumable commands, automatic-update policy selection, and accessibility in non-interactive terminals. Use `/prototype` with live user feedback; link the chosen prototype from the resolution.
