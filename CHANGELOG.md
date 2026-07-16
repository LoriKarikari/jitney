# Changelog

## [0.2.0](https://github.com/LoriKarikari/jitney/compare/v0.1.0...v0.2.0) (2026-07-16)


### Features

* **cli:** automate Cloudflare and GitHub App setup ([#59](https://github.com/LoriKarikari/jitney/issues/59)) ([af1c721](https://github.com/LoriKarikari/jitney/commit/af1c7213f7dbf886304085b52f5e289a125ff493))

## 0.1.0 (2026-07-16)


### ⚠ BREAKING CHANGES

* **scheduler:** migrations are squashed into one baseline and the Scheduler moves to global-v3, discarding existing test-environment state.

### Features

* **observability:** correlate runner lifecycle events ([#19](https://github.com/LoriKarikari/jitney/issues/19)) ([7e6ef49](https://github.com/LoriKarikari/jitney/commit/7e6ef49358f9529aa83bc9c4f460bc5035be6062))
* run one GitHub Actions job on Cloudflare Containers ([#13](https://github.com/LoriKarikari/jitney/issues/13)) ([c648951](https://github.com/LoriKarikari/jitney/commit/c648951ece8b2cc70183c006f1c82b845275d2b3))
* **scheduler:** backfill missed queued jobs ([#37](https://github.com/LoriKarikari/jitney/issues/37)) ([cc25fff](https://github.com/LoriKarikari/jitney/commit/cc25fff84370b58ec9d4742ef6c1eec5c558600a))
* **scheduler:** bind jobs to assigned runners ([#17](https://github.com/LoriKarikari/jitney/issues/17)) ([630effb](https://github.com/LoriKarikari/jitney/commit/630effbc333b95239ff5dec83c1b1545319b237d))
* **scheduler:** enforce idempotency and admission limits ([#15](https://github.com/LoriKarikari/jitney/issues/15)) ([a92f2d3](https://github.com/LoriKarikari/jitney/commit/a92f2d3abb9c06a947700f4158330be2a73c1cac))
* **scheduler:** enforce the runtime deadline ([#32](https://github.com/LoriKarikari/jitney/issues/32)) ([725cbcb](https://github.com/LoriKarikari/jitney/commit/725cbcba54408272b074bcffbfd0c9ee5322c502))
* **scheduler:** expire unassigned runner attempts ([#29](https://github.com/LoriKarikari/jitney/issues/29)) ([cabb29a](https://github.com/LoriKarikari/jitney/commit/cabb29ada09226077dbe2e9aac73b0972e05c488))


### Bug Fixes

* **ingress:** restore Octokit webhook verification ([#53](https://github.com/LoriKarikari/jitney/issues/53)) ([c366477](https://github.com/LoriKarikari/jitney/commit/c3664770303c02506cec8455fa37729379c3f921))
* **reconciliation:** paginate queued job discovery ([#49](https://github.com/LoriKarikari/jitney/issues/49)) ([a5fb48e](https://github.com/LoriKarikari/jitney/commit/a5fb48e87d67827bfdfaa420c6670239ef4de384))
* **scheduler:** derive durable schema from one authority ([#20](https://github.com/LoriKarikari/jitney/issues/20)) ([df7f901](https://github.com/LoriKarikari/jitney/commit/df7f901aec71e67fecbc04b285f7ee030d262a83))
* **scheduler:** destroy the container before deleting the runner ([#34](https://github.com/LoriKarikari/jitney/issues/34)) ([4f4bd8a](https://github.com/LoriKarikari/jitney/commit/4f4bd8a0f60e0e9055aaf158eca41866fecaca80))
* **scheduler:** pull the alarm forward for earlier runtime deadlines ([#35](https://github.com/LoriKarikari/jitney/issues/35)) ([a4254b2](https://github.com/LoriKarikari/jitney/commit/a4254b2ca51e5d06e4b15429b33951ca76a892b2))


### Code Refactoring

* **scheduler:** normalize lifecycle persistence ([#38](https://github.com/LoriKarikari/jitney/issues/38)) ([595108a](https://github.com/LoriKarikari/jitney/commit/595108a776785c7d5b0d26eb84c8c45914cff16d))
