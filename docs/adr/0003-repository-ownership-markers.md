# 3. Repository ownership markers are GitHub environments

Status: accepted, 2026-08-01

## Context

One repository belongs to exactly one deployment. Deployment receipts prove
that inside a single Cloudflare account, but they cannot see a deployment
that lives in another account or one whose receipt was lost, so the claim
has to be recorded on the GitHub side of the repository itself.

The first implementation wrote a `JITNEY_DEPLOYMENT` repository variable.
That never reached a real install: GitHub's App manifest endpoint rejects
the Variables permission with `Default permission records resource is not
included in the list`, and manifests are how Jitney onboards. The
permission is documented for the Actions variables API but is missing from
the App permission set the manifest validates against, and from
`app-permissions` in GitHub's own OpenAPI description
(github/rest-api-description#5437).

## Decision

Each claimed repository gets a GitHub environment named
`jitney-<deployment ULID>`. It holds no secrets, variables, or protection
rules; the name is the entire marker. `deploy` refuses a repository that
carries another deployment's marker, `list` classifies a missing or foreign
marker as drift, `repair` recreates a missing one, and `destroy` deletes it
through the Worker before the App is removed.

`environments: write` is accepted in App manifests, and Jitney already
requires `administration: write` to register self-hosted runners, which is
the broader of the two.

## Consequences

- The marker is advisory and install-time. Nothing on the job path reads it,
  so two deployments installed on one repository would both still serve
  runners. It catches accidental duplicate setup; it does not enforce
  exclusivity at dispatch.
- Environments are a deployment-gating concept, so this overloads them.
  The marker appears under repository Settings with no explanation, because
  GitHub environments have no description field.
- The App can create and delete environments in claimed repositories,
  including ones the user created.
- If GitHub adds Variables to the manifest permission set, a variable would
  be the better home and this becomes worth revisiting.
