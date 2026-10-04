# Changelog

## [0.4.1](https://github.com/LoriKarikari/jitney/compare/v0.4.0...v0.4.1) (2026-10-04)


### Bug Fixes

* **cli:** wait out stale KV reads before checking the receipt lease ([#173](https://github.com/LoriKarikari/jitney/issues/173)) ([422d553](https://github.com/LoriKarikari/jitney/commit/422d5530041a2ca7b17661643b97dab4faa0d906))

## [0.4.0](https://github.com/LoriKarikari/jitney/compare/v0.3.0...v0.4.0) (2026-10-04)


### Features

* **cli:** adopt a Deployment that has no receipt ([#165](https://github.com/LoriKarikari/jitney/issues/165)) ([f3df775](https://github.com/LoriKarikari/jitney/commit/f3df77598ef84643213d6024c2ef820111306948))


### Bug Fixes

* **ci:** run prerelease publishing when Release Please is skipped ([#170](https://github.com/LoriKarikari/jitney/issues/170)) ([77680fc](https://github.com/LoriKarikari/jitney/commit/77680fc4053906cc7b67881008c01cd825781ea3))
* **cli:** copy upgrade images with pull and push credentials ([#172](https://github.com/LoriKarikari/jitney/issues/172)) ([ef5536b](https://github.com/LoriKarikari/jitney/commit/ef5536bd004a7b51ad4be9a78356ce42ab0823cf))
* **cli:** pin the Effect family so npx installs one version ([#171](https://github.com/LoriKarikari/jitney/issues/171)) ([96c14d5](https://github.com/LoriKarikari/jitney/commit/96c14d5af91cc5e9ae8aa2833246988ecda5b8fb))

## [0.3.0](https://github.com/LoriKarikari/jitney/compare/v0.2.0...v0.3.0) (2026-09-29)


### ⚠ BREAKING CHANGES

* **cli:** deployments created by Jitney 0.2.x must be removed and reinstalled before their names can be reused.

### Features

* adopt Alchemy for lifecycle resources ([#92](https://github.com/LoriKarikari/jitney/issues/92)) ([6e46277](https://github.com/LoriKarikari/jitney/commit/6e46277f2c88516f84c93bd8a93691c8abed2458)), closes [#77](https://github.com/LoriKarikari/jitney/issues/77)
* **cli:** add deployment drift listing ([#95](https://github.com/LoriKarikari/jitney/issues/95)) ([cae6427](https://github.com/LoriKarikari/jitney/commit/cae6427fb20fef907a1aecfd38da36b67073f03e))
* **cli:** add deployment receipt store and lease ([#93](https://github.com/LoriKarikari/jitney/issues/93)) ([21b2113](https://github.com/LoriKarikari/jitney/commit/21b2113c464159a19400e87a597fa43ba682c21d))
* **cli:** add deployment repair ([#98](https://github.com/LoriKarikari/jitney/issues/98)) ([b1554be](https://github.com/LoriKarikari/jitney/commit/b1554be7ede29fc7cdf2d76ca2fd1298b831b5d1))
* **cli:** add resumable deployment destroy ([#101](https://github.com/LoriKarikari/jitney/issues/101)) ([c5aca5a](https://github.com/LoriKarikari/jitney/commit/c5aca5a1bd30e9382dc914f0a9c3b0e7786bcc79))
* **cli:** add upgrade and rollback lifecycle ([#122](https://github.com/LoriKarikari/jitney/issues/122)) ([2e791a6](https://github.com/LoriKarikari/jitney/commit/2e791a6651a979f5cca8e3de632bb72d92b5aed5))
* **cli:** rewrite deploy around lifecycle receipts ([#94](https://github.com/LoriKarikari/jitney/issues/94)) ([adfc54f](https://github.com/LoriKarikari/jitney/commit/adfc54f438d3ae89b6923e99d44253058de5a1b0))
* migrate Jitney to Effect 4 beta ([#90](https://github.com/LoriKarikari/jitney/issues/90)) ([adf3a60](https://github.com/LoriKarikari/jitney/commit/adf3a60336e9b293e6b7c6db868e86305f07a2f6)), closes [#87](https://github.com/LoriKarikari/jitney/issues/87) [#77](https://github.com/LoriKarikari/jitney/issues/77)


### Bug Fixes

* **ci:** allow first lifecycle upgrade ([#129](https://github.com/LoriKarikari/jitney/issues/129)) ([d2078ed](https://github.com/LoriKarikari/jitney/commit/d2078ed7d2e9b01a06fe4d4e5bee71add9233b76))
* **ci:** remove the legacy Wrangler deploy ([#100](https://github.com/LoriKarikari/jitney/issues/100)) ([b1857e4](https://github.com/LoriKarikari/jitney/commit/b1857e44142c4ee9adfa3b266e8228c638ce7e35))
* **ci:** skip unconfigured lifecycle smoke ([#128](https://github.com/LoriKarikari/jitney/issues/128)) ([0ffa316](https://github.com/LoriKarikari/jitney/commit/0ffa3160dad67201b89c2acf323a248ebc9e61d4))
* **cli:** drop stale upgrade hint from ExistingWorkerError ([#138](https://github.com/LoriKarikari/jitney/issues/138)) ([e33dda5](https://github.com/LoriKarikari/jitney/commit/e33dda5e2d44630dcc2749391c52f179c1ba232e))
* **cli:** keep Alchemy bootstrap non-interactive and name uninstall identity failures ([#103](https://github.com/LoriKarikari/jitney/issues/103)) ([a4aaa2c](https://github.com/LoriKarikari/jitney/commit/a4aaa2c936a36e65cb8358d309bce14934809460))
* **cli:** preserve decoded Cloudflare receipt values ([#105](https://github.com/LoriKarikari/jitney/issues/105)) ([ea1bf2c](https://github.com/LoriKarikari/jitney/commit/ea1bf2c6a9bf84666c337bcd08cfbc8e4fdb9d3c))
* **cli:** unblock live lifecycle cleanup ([#119](https://github.com/LoriKarikari/jitney/issues/119)) ([e144aab](https://github.com/LoriKarikari/jitney/commit/e144aab0f56b7d4542e86af255226c2404de33d4))
* **image:** update the runner to 2.337.0 ([#139](https://github.com/LoriKarikari/jitney/issues/139)) ([421ef8c](https://github.com/LoriKarikari/jitney/commit/421ef8c452f78f5cdd62364ab12e4b3465b593e8))
* **reconciliation:** discover queued jobs in in-progress runs ([#136](https://github.com/LoriKarikari/jitney/issues/136)) ([2d10582](https://github.com/LoriKarikari/jitney/commit/2d10582fa80a7291b9f992076eb77bfebf0f9947))
* **runner:** derive RunnerContainer sleepAfter from the runtime deadline ([#135](https://github.com/LoriKarikari/jitney/issues/135)) ([6c0d52b](https://github.com/LoriKarikari/jitney/commit/6c0d52bb0c1016202a32cb5536efed6ef1f41186))
* **scheduler:** expire only attempts that are still overdue ([#133](https://github.com/LoriKarikari/jitney/issues/133)) ([c76cabc](https://github.com/LoriKarikari/jitney/commit/c76cabcd6a332e196f0581965bee3f0ca9d9291a))
* **scheduler:** reclaim runners no job will claim ([#134](https://github.com/LoriKarikari/jitney/issues/134)) ([0c84d53](https://github.com/LoriKarikari/jitney/commit/0c84d534074f2477433c3597bdb07d5362cb455a))

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
