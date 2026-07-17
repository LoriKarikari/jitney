# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Wayfinding operations

Wayfinder maps use the local Markdown tracker under `docs/wayfinder/<effort>/` so their dependency graph and research assets can evolve on a reviewable branch. The map is `map.md`; child tickets live in `tickets/`. Ticket frontmatter records `status`, `assignee`, and `blocked-by`. Claim an open, unblocked ticket by setting `assignee` before doing any work. Record its answer under `## Resolution`, close it by setting `status: closed`, and add one linked gist to the map's **Decisions so far** section.

## When a skill says "publish to the issue tracker"

Create a GitHub issue unless the skill is operating on a local Wayfinder map.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
