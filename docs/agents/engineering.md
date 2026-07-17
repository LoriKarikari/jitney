# Engineering conventions

How work happens in this repo: branches, commits, pull requests, issues, and
testing. Read this before starting any implementation work.

## TL;DR

- Branch from `main`, open a PR back to `main`.
- Use [conventional commits](#commit-messages).
- Never push directly to `main`.
- Tests must pass before review.
- Squash-merge on approval.

## Branching

All work happens on feature branches cut from `main`. No exceptions for
`main` — every change lands through a pull request.

### Branch naming

```
<type>/<short-description>
<type>/<issue-number>-<short-description>
```

Types match conventional commit types:

| Branch prefix | Use for                         |
| ------------- | ------------------------------- |
| `feat/`       | New features                    |
| `fix/`        | Bug fixes                       |
| `docs/`       | Documentation                   |
| `refactor/`   | Code restructuring, no behavior change |
| `test/`       | Test additions or improvements  |
| `chore/`      | Tooling, deps, CI, maintenance  |
| `perf/`       | Performance improvements        |
| `ci/`         | CI/CD changes                   |

Examples:

```
feat/scheduler-durable-object
fix/webhook-idempotency-duplicate-delivery
docs/runner-image-internals
refactor/extract-github-adapter
```

### Workflow

```bash
git switch main
git pull origin main
git switch -c feat/scheduler-durable-object
# ... make changes ...
git push -u origin feat/scheduler-durable-object
# Open a PR on GitHub
```

Rebase on `main` before opening a PR and whenever `main` has moved:

```bash
git fetch origin
git rebase origin/main
```

Do not merge `main` into your branch. Rebase keeps the history linear and the
PR diff clean.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

<optional body>

<optional footer>
```

### Types

| Type       | Use for                                              |
| ---------- | --------------------------------------------------- |
| `feat`     | New feature visible to users                        |
| `fix`      | Bug fix                                             |
| `docs`     | Documentation only                                  |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `test`     | Adding or correcting tests                          |
| `chore`    | Build, tooling, deps, CI — no production code change |
| `perf`     | Performance improvement                             |
| `ci`       | CI pipeline changes                                 |
| `build`    | Build system or dependencies                        |
| `revert`   | Reverting a previous commit                         |

### Scope

The scope is optional but encouraged for multi-module repos. For Jitney, common
scopes include `scheduler`, `ingress`, `runner`, `image`, `webhook`, `docs`.

### Breaking changes

Append `!` after the type/scope and describe the change in the footer:

```
feat(scheduler)!: reap unassigned runners on assignment deadline

BREAKING CHANGE: scheduler state machine adds timed_out transition
```

### Examples

```
feat(scheduler): bind job to actual runner_name from in_progress
fix(webhook): verify HMAC against raw bytes, not re-serialized JSON
docs: add Podman research brief
refactor(github): extract installation-token minting to adapter
test(scheduler): cover cross-assignment cleanup
chore(deps): bump wrangler to 4.110.0
```

## Pull requests

### Before opening

- Rebase on the latest `main`.
- Run the full check suite locally (typecheck, lint, tests).
- Write tests for new behavior. Every PR should include tests that validate
  the change.
- If the PR addresses an issue, reference it in the body: `Closes #123`.

### PR title

Use a conventional commit message as the PR title. The squash-merge will use
this as the commit message:

```
feat(scheduler): bind job to actual runner_name from in_progress
```

### PR body

Describe what changed and why. For non-trivial changes, explain the approach
and any alternatives considered. Link the issue. List the tests you ran.

### Review process

- One approval required for merge.
- Address review feedback with new commits, not force-pushes. Use
  `git commit --fixup` for small fixes. Force-pushing after review makes it
  hard to track what changed.
- The maintainer squash-merges on approval, so the commit history on your
  branch does not need to be clean — but the PR title must be correct, since
  it becomes the squash commit message.

### Squash merge

All PRs are squash-merged into `main`. This produces a linear history with one
commit per PR, each following the conventional commit format.

## Releases

Release Please opens and updates a bot-authored release PR from conventional
commits on `main`. The PR updates `CHANGELOG.md`, `version.txt`, and the release
manifest. A maintainer reviews and approves that PR before merging it; the
workflow never approves or merges its own work. Merging the release PR creates
the version tag and GitHub release, then publishes the matching runner image as
`ghcr.io/lorikarikari/jitney:<version>` and the `get-jitney` package to npm. The
public `latest` image tag points to the newest release, but deployments use the
versioned tag.

The repository must enable **Settings → Actions → General → Allow GitHub Actions
to create and approve pull requests** so the built-in `GITHUB_TOKEN` can open
the PR. Despite the setting's combined name, Jitney grants no workflow an
approval step. GitHub does not trigger other workflows for pull requests opened
with `GITHUB_TOKEN`, so review the generated-only release diff directly. The
code represented by the release has already passed CI in its originating PRs.
The runner image is published to GitHub Container Registry with the built-in
`GITHUB_TOKEN`; it requires no separate registry credentials. The `get-jitney`
npm package trusts `.github/workflows/release-please.yml` as its GitHub Actions
publisher. Releases use npm OIDC with provenance and never use an npm token.

The release manifest starts at `0.0.0`, and the first public release is
explicitly `0.1.0`. Its changelog includes the full releasable pre-release
history. Before 1.0, breaking changes bump the minor version; features use the
normal minor bump and fixes use a patch bump.

## Issues

Issues live on GitHub. Use `gh` CLI for all operations.

### Creating issues

```bash
gh issue create --title "feat: support org-level runner groups" --body "..."
```

Use a conventional commit prefix in the title when the issue describes
implementable work. This makes the issue-to-commit path obvious.

### Labels

The project uses five triage labels:

| Label             | Meaning                                  |
| ----------------- | ---------------------------------------- |
| `needs-triage`    | Maintainer needs to evaluate             |
| `needs-info`      | Waiting on reporter for more information |
| `ready-for-agent` | Fully specified, ready for an AFK agent  |
| `ready-for-human` | Requires human implementation            |
| `wontfix`         | Will not be actioned                     |

### Linking issues and PRs

- Reference issues in PR bodies: `Closes #123`, `Fixes #123`, `Ref #123`.
- GitHub automatically closes the issue when the PR merges if you use
  `Closes` or `Fixes`.

## Testing

- Test external behavior, not implementation details. A good test verifies
  what the module does, not how it does it.
- Prefer the highest seam possible. If you can test through a public API, do
  that instead of testing internal functions.
- Every PR that changes behavior must include tests that would fail without
  the change.
- Run the full test suite before opening a PR. If tests are slow, filter to
  the relevant package, but run the full suite before requesting review.

## Tooling

The repository has two self-contained modules. Go code and its module tooling
live under `supervisor/`. TypeScript control-plane code and its package tooling
live under `worker/`. The root Taskfile delegates to both.

- **Taskfile** drives local automation: `task ci` runs the same checks as CI
  (verify, lint, race tests, govulncheck, gosec).
- **golangci-lint** with `supervisor/.golangci.yml` is the lint source of
  truth. Run `task lint` after every significant change.
- CI runs tests with `-race -shuffle=on`, checks `go mod tidy` drift, and
  runs govulncheck and gosec on every PR that touches Go code. CodeQL runs the
  `security-extended` suite for both Go and TypeScript and uploads findings to
  GitHub code scanning.
- Workflows are path-scoped: Go and Go CodeQL checks run only when
  `supervisor/**` changes; TypeScript and TypeScript CodeQL checks only when
  `worker/**` changes.
- The supervisor builds as a static `CGO_ENABLED=0` linux/amd64 binary; it
  ships inside the runner image, not as a released archive.
- `//nolint` directives must name the linter and carry a justification.

### TypeScript

- The control plane lives under `worker/` and uses pnpm with a committed
  lockfile. Run `task ts:install` for a reproducible install.
- Wrangler generates binding and runtime declarations in
  `worker/worker-configuration.d.ts`. Regenerate them after changing
  `wrangler.jsonc`.
- TypeScript uses strict mode, including unchecked-index and exact-optional
  checks.
- Oxfmt is the formatter. Oxlint, including its type-aware rules, is the lint
  source of truth. Use `pnpm fmt` to write formatting and `pnpm lint` to lint.
- Knip fails the build on unused files, exports, and dependencies. Run
  `pnpm knip` before opening a PR.
- The Durable Object schema authority is `worker/src/schema.ts`. After
  changing it, run `pnpm exec drizzle-kit generate` and commit the generated
  migration; the Scheduler applies migrations on construction. Never edit an
  already-merged migration.
- Schema changes are additive from here on. Do not squash migration history,
  rename the Scheduler Durable Object, or otherwise discard deployed state.
  The one clean-slate reset (`global-v3`, baseline migration) already
  happened, pre-users, with explicit maintainer approval. Migrations that
  restructure tables must adopt existing rows and be proven against seeded
  old-format data before merge.
- Vitest tests execute inside workerd through Cloudflare's Workers pool rather
  than a Node.js approximation.
- `task ts:check` runs generated types, typechecking, formatting checks,
  linting, Knip, and tests. CI runs the same commands as separate PR checks.
- Scheduler tests exercise lifecycle behavior through `SchedulerLifecycle` and
  fake provisioning adapters; they should not import table declarations or
  construct a Drizzle database directly. A local `runDurableObjectAlarm` smoke
  test covers the real alarm wiring with an empty Scheduler. Live canaries cover
  real binding integration.
- Do not manually rebuild a record by repeating `field: source.field` for each
  property when its shape already exists. Prefer destructuring, property
  shorthand, object spread, or the library's projection helper (for example,
  Drizzle's `getTableColumns`). Select fields individually only when the
  narrower projection is meaningful.
- Keep transport and storage nullability at their boundaries. Validate or
  classify nullable headers and columns before calling domain operations; do
  not spread `T | null` through interfaces that require a present value.

### SDK-first integrations

Before writing an API call, helper, or adapter, check whether Octokit or the
Cloudflare SDK already provides it. Prefer generated, typed methods such as
`octokit.rest.*` and native Cloudflare binding APIs over generic
`octokit.request()`, raw `fetch()`, or a hand-written wrapper. Use the generic
interface only when the installed SDK has no suitable typed operation.

## Git hygiene

- **Never push directly to `main`.** Every change goes through a PR.
- **Rebase, don't merge.** Keep your branch up to date with `git rebase
  origin/main`, not `git merge main`.
- **Don't force-push after review.** Add fixup commits instead.
- **Squash-merge on approval.** The maintainer handles this.
- **One PR per feature or fix.** Split unrelated changes into separate PRs.
