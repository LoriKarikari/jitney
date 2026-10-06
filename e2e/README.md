# Live E2E checks

These checks prove Jitney on the fixture Deployment `jitney`, which serves
`LoriKarikari/jitney-test`. Each is a vitest file that asserts named checks and
writes them, with the evidence behind them, to `e2e/results/<name>.json`.

They need `gh` logged in with access to `jitney-test`, and the Cloudflare token
that `varlock` loads from `.env.schema`. They run against whatever version the
fixture is on. To test unreleased work, publish a prerelease and move the
fixture to it first:

```bash
gh workflow run release-please.yml --ref main
gh workflow run jitney.yml -R LoriKarikari/jitney-test \
  -f version=<prerelease>
```

Then run one check, or several in a row:

```bash
pnpm e2e webhook-down
pnpm e2e unclaimed-runner deploy-during-job
```

| Check | Proves | Takes |
| --- | --- | --- |
| `webhook-down` | With no webhook, jobs finish, each Job's end state comes from GitHub, and a runner busy past the assignment deadline is kept. | 20 min |
| `deploy-during-job` | A Worker deployed during a 15-minute job does not stop its runner. | 17 min |
| `unclaimed-runner` | A runner no job claims stops at the assignment deadline. | 7 min |
| `start-latency` | Each canary job starts within 60 seconds. `E2E_RUNS` sets the run count (default 5), and `E2E_VERSION` the version the canary upgrades to (default the fixture's current one). | 3 min per run |
| `confirm-prompt` | The `repair` and `destroy` prompt with closed, piped, and empty input. Needs no fixture. | 10 s |

`webhook-down` switches the Worker's `workers.dev` route off and restores it
when it ends. A detached watchdog restores it after 40 minutes if the run is
killed.

The `jitney-test` canary (`jitney.yml`) runs every Monday. It upgrades the
fixture to `latest` and fails unless a job starts on its first Runner Attempt
within 60 seconds. `long-job.yml` there is the job these checks dispatch.
