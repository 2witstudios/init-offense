# Changelog

All notable changes to the init-offense template. The npm package
`init-offense` (in `create/`) only fetches this template, so it is versioned
separately and changes only when the bootstrapper itself changes.

## Unreleased

Everything since the template was extracted; becomes 0.1.0 once a fresh wizard run passes end to end with no template changes.

### Setup

- `npx init-offense my-app` runs a guided wizard: tools check and install
  (with consent), GitHub and PageSpace sign-in, a public or private
  repository, a PageSpace drive, the review-record GitHub App (two browser
  clicks), free local ports, and the app running and open in the browser.
- A temporary PageSpace setup key is minted, used and revoked during setup;
  the drive gets its own key with an editing "Agent" role.
- Local sign-in needs no email provider: links are printed in the terminal
  (`[dev-mail]`) in development on localhost only.

### App

- Bun + Turborepo + Next.js with passwordless sign-in (magic link and
  passkey), Postgres, Redis, CSP and CSRF protection.
- ADR 0048's authorization core: a pure `authorize`, a fact loader,
  `authorizeRequest(identity, …)` and `readRoute` for page reads.

### Agent operating system

- `project.config.json` holds every drive, page and channel id; no script
  hard-codes one.
- `bun drive:bootstrap` builds or repairs the drive idempotently; `--check`
  verifies it, including that the agent key can edit.
- `bun plan:review` with a choice of read-only reviewer: Codex (with a
  model), Claude Code or OpenCode.
- Board, decision, review-record and merge follow-up tooling; the
  `review-record` merge gate.

### Local development

- Every checkout, git worktree and standalone clone gets its own database
  slot; slots are pruned only when their checkout no longer exists.
- Port overrides (`<APP>_POSTGRES_PORT`, `_REDIS_PORT`, `_APP_PORT`) let
  several projects share one machine.

### Docs

- https://init-offense.pagespace.site/
