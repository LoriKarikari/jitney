# Live E2E checks

These scripts prove Jitney on the fixture Deployment `jitney`, which serves
`LoriKarikari/jitney-test`. Each one prints `result=PASS` or `result=FAIL`,
exits non-zero on failure, and leaves its evidence in `e2e/results/`.

They need `gh` with access to `jitney-test`, `varlock` with the Cloudflare
token from `.env.schema`, and the fixture on the version under test. To test
unreleased work, publish a prerelease and move the fixture to it first:

```bash
gh workflow run release-please.yml --ref main
gh workflow run jitney.yml -R LoriKarikari/jitney-test \
  -f version=<prerelease>
```

| Script | Proves | Takes |
| --- | --- | --- |
| `webhook-down.sh` | With no webhook, jobs finish and each Job's end state comes from GitHub. A runner busy past the assignment deadline is kept. | 20 min |
| `deploy-during-job.sh` | A Worker deployed during a 15-minute job does not stop its runner. | 17 min |
| `unclaimed-runner.sh` | A runner no job claims stops at the assignment deadline. | 7 min |
| `start-latency.sh LABEL [RUNS] [VERSION]` | Queued-to-start time of the canary, with the median. | 3 min per run |
| `confirm-prompt.sh` | The `repair` and `destroy` prompt with closed, piped, and empty input. Needs no fixture. | 10 s |

The `jitney-test` canary (`jitney.yml`) runs every Monday. It upgrades the
fixture to `latest` and fails unless a job starts on its first Runner Attempt
within 60 seconds. `long-job.yml` there is the job the scripts above dispatch.
