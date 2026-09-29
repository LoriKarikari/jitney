# gh-runner-broker: implementation lessons

Asset for ticket 4. Source of truth: the author's blog post (2026-07-02, blog.aman.wiki). **The GitHub repo (jn-aman/gh-runner-broker) is unreachable as of 2026-07-11** — API 404, no Wayback snapshot, no forks — so this brief is drawn from the post's detailed writeup, and Jitney reimplements from the described design rather than reading code. Consequence: nothing to copy, no license questions.

**Superseded where noted:** the later [architecture review](architecture-review.md) replaces the stateless webhook path, job-ID cleanup, 20-minute timeout, and direct `run.sh` supervision. This file remains a record of prior-art lessons, not the current Jitney design.

## Steal this (proven design)

- **Mechanism proved:** verify `X-Hub-Signature-256` with a constant-time HMAC-SHA-256 comparison, authenticate as the App, mint a short-lived installation token restricted to the verified repository, call `generate-jitconfig`, and boot a one-job runner. Jitney places durable scheduling between webhook acceptance and those side effects.
- **Label routing lesson:** route only recognized labels, but do not merely ignore unknown combinations. Jitney publishes four opaque labels, requires exactly one recognized Jitney label, and verifies that the minted runner can satisfy every requested label.
- **GitHub App recipe:** repository permissions Administration read/write (runner registration lives there), Actions read-only, and Metadata read-only; subscribe to **Workflow job**. Runtime installation and repository identity come from each verified payload. V1 accepts private repositories only.
- **Orphan cleanup lesson:** a timeout is necessary, but one timeout is the wrong model. Jitney uses a short assignment deadline and a separate maximum runtime after actual assignment, plus event-driven cleanup and reconciliation.
- **DinD lesson:** rootless dockerd, iptables disabled, and host networking are the relevant constraints. Cloudflare's current plain-Containers FAQ now supports this officially. The CLI-wrapper idea may help ordinary build/run calls but cannot establish compatibility with GitHub `container:` or `services:`; ticket 15 tests those explicitly.
- **Never saw off your own branch:** the broker's *own* deploy job runs on GitHub-hosted runners, never on its own fleet — otherwise a bad runner image can't be fixed by a system that needs a working runner to deploy.

## Avoid this (his four production bugs)

1. **PKCS#1 vs PKCS#8.** GitHub App keys arrive as PKCS#1; Workers Web Crypto only imports PKCS#8. He hand-prepended the 14-byte ASN.1 wrapper in code. Also: his test passed because the fixture generated its own PKCS#8 key — test with a real GitHub-format key.
2. **`schedule()` numbers are seconds-of-delay, not timestamps.** `schedule(Date.now() + 20min)` booked his cleanup for the year ~57,000. Pass a `Date` object.
3. **ICU on ubuntu:24.04.** The runner installer used to miss `libicu74`. Current upstream handles it, and Jitney's official runner base already carries the native dependency set.
4. **glibc Node on musl.** On Alpine, the runner's bundled glibc Node dies (`fcntl64: symbol not found`). His fix: symlink bundled Node to the system musl Node. Cleaner for us: just use a glibc base and never meet this bug.

## Current disposition

- Convert the App key to PKCS#8 during setup; key rotation instructions are part of the install docs.
- Base on `ghcr.io/actions/actions-runner`, then publish the derived image to Cloudflare's managed registry.
- Docker labels are conditional on ticket 15's compatibility result; a wrapper cannot substitute for testing job and service containers.
- Assignment timeout and maximum runtime are separate scheduler controls. Ticket 14 proves behavior; the final spec chooses defaults.
- Ticket 9 supplies cold-start, sizing, and cost evidence.
