# Acme

Acme is generated from **init-offense**, a project template that starts a
new product with the boring, hard parts already done and verified:

- **Auth**: Better Auth passwordless sign-in (magic link plus passkeys),
  Resend mail with delivery diagnostics and suppression, Redis-backed rate
  limits, session revocation, and account erasure.
- **Platform**: a Bun + Turborepo modular monolith with a Next.js web app,
  a native WebSocket realtime service fed by a transactional outbox,
  PostgreSQL (Drizzle) as the source of truth, expendable Redis, typed
  config, structured logging, privacy classification, error tracking and
  analytics adapters, and Fly deploy rails.
- **Agent operating system**: `AGENTS.md`, mechanical gates (`bun check`,
  `bun verify`, boundaries, policy, dead code, duplication, evidence),
  parallel worktree slots, `pu` orchestration, an owner/autonomous merge
  model with independent review records, and repository skills.
- **PageSpace drive**: a project drive with a roadmap board, Issues
  buckets, Plans / Prompts / Reviews / Library folders, Agent Memory and
  team channels, wired to the repository through `project.config.json`.

The product domain is a deliberately tiny placeholder in `packages/domain`.
Replace it with your own rules.

## Stack

Bun · TypeScript (strict) · Turborepo · Next.js (App Router) · React ·
Tailwind v4 · PostgreSQL 18 + Drizzle · Redis 8 (Bun native client) · Zod ·
Pino · OpenTelemetry API · Better Auth · Resend · Playwright · Docker
Compose · GitHub Actions · Fly.io.

## Quickstart

Create a project from the template checkout:

```sh
bun cli/init.ts new ../widget --name widget
```

Flags:

| Flag                      | Effect                                                                 |
| ------------------------- | ---------------------------------------------------------------------- |
| `--name <slug>`           | Package scope and identifier (`@widget/*`); replaces `acme` everywhere |
| `--display <name>`        | Human-facing product name; replaces `Acme` (defaults from `--name`)    |
| `--repo <owner/name>`     | GitHub repository slug recorded in `project.config.json`               |
| `--without realtime,docs` | Leave out optional parts (the realtime service, the docs pipeline)     |
| `--no-drive`              | Skip PageSpace drive bootstrap                                         |
| `--no-github`             | Skip creating the GitHub repository and its rulesets                   |

Then, in the new project:

```sh
bun install --frozen-lockfile
cp .env.example .env
bun dev:agent
```

`bun dev:agent` runs `bun slot:up` (the shared Compose services plus this
checkout's migrated dev and test databases), loads the deterministic
development seed, starts the web and realtime apps, waits for readiness,
and prints the local URLs, seeded development identities, and seed version.
Use `bun dev` when `bun slot:up` has already run.

### What bootstrap does

Unless `--no-drive` is given, `bun drive:bootstrap` (run by the CLI, or by
hand later) provisions the PageSpace drive: the Roadmap board, the Issues
list and its buckets (Bugs, Test coverage, Agent tooling, Doc and spec
drift, User feedback, Backlog, Pending decisions), the Plans, Prompts,
Reviews and Library folders, the conventions and contract pages, Agent
Memory, the documentation tree, the agents, and the standup, epic-updates,
sprint-room and incidents channels. It writes every id into
`project.config.json` and rewrites the drive block in `AGENTS.md`. Until it
runs, PageSpace-backed commands refuse with a "not provisioned" error.

Unless `--no-github` is given, the CLI creates the repository, pushes
`main`, and applies the branch ruleset and required checks named in
`project.config.json` (`gates.requiredChecks`).

### Manual steps that remain

These need a human with the right accounts; nothing in the repository can
do them for you:

1. **Agent machine user.** Create a GitHub machine account for autonomous
   agents, give it write access, and fill in `.env.agent` in the main
   checkout from `.env.agent.example`. Until then agents act as the owner
   and `bun doctor` warns.
2. **Review-record GitHub App.** Create a GitHub App that mints the
   `review-record` check, install it on the repository, and store its id and
   private key as the `REVIEW_RECORD_APP_ID` repository variable and the
   `REVIEW_RECORD_APP_KEY` repository secret. Then require `review-record` in the `main` ruleset;
   see [review record](docs/development/review-record.md).
3. **Resend.** Verify a sending domain and set `RESEND_API_KEY` and
   `AUTH_EMAIL_FROM` as deploy secrets (and in `.env` to send real mail
   locally); see [auth delivery](docs/operations/auth-delivery.md). Local
   development works without it: `bun dev` prints sign-in links to the
   terminal ([signing in locally](docs/development/local-development.md#signing-in-locally)).
4. **Fly.** Create the staging and production apps, PostgreSQL and Redis,
   and set their secrets, plus the `FLY_API_TOKEN` and
   `FLY_MIGRATE_API_TOKEN` repository secrets the deploy workflows use; see
   [deploy to staging](docs/operations/deploy-staging.md)
   and [production](docs/operations/production.md).
5. **PageSpace credentials.** Provide a drive-scoped `PAGESPACE_TOKEN`
   (locally and as a repository secret) for the docs pipeline and board
   scripts, and the channel webhook secrets the workflows post through
   (`PAGESPACE_SPRINT_ROOM_WEBHOOK_URL`/`_SECRET`,
   `PAGESPACE_INCIDENTS_WEBHOOK_URL`/`_SECRET`).

## Where work belongs

| You are building…               | It lives in…                                                   |
| ------------------------------- | -------------------------------------------------------------- |
| A product feature               | `apps/web/src/features/<feature>/` + routes in `src/app`       |
| Domain rules                    | `packages/domain` (contracts via `@acme/protocol`)             |
| Portable messages/snapshots     | `packages/protocol`                                            |
| Durable records, migrations     | `packages/db`                                                  |
| Ephemeral coordination          | `packages/redis`                                               |
| Live delivery to browsers       | `apps/realtime` (topics in `@acme/protocol`)                   |
| Cross-cutting platform concerns | `config`, `clock`, `errors`, `logger`, `observability`, `auth` |

Agents: read `AGENTS.md` first — it is the binding engineering contract.

## Verification

```sh
bun check              # pre-push gate: static, policy, duplication, unit, and build gates (catalog: AGENTS.md)
bun run duplication    # copy-paste tripwire: fails on any clone not in .jscpd-baseline.json (ADR 0026)
bun invariants         # execute every registered domain invariant fixture
bun verify             # bun check plus migration, integration, and browser gates
bun test:integration   # real PostgreSQL/Redis + web vertical proof
bun test:e2e           # production-mode browser suite (Playwright)
```

## Documentation

- `AGENTS.md` — the operating map for humans and agents
- `docs/architecture/overview.md` — boundaries, package map, ownership
- `docs/architecture/persistence.md` — PostgreSQL/Redis semantics
- `docs/dependencies.md` — why every major dependency exists, and its docs
- `docs/decisions/` — ADRs (tradeoffs, not just outcomes); start at the [index](docs/decisions/README.md)
- `docs/development/` — local setup, testing, extension recipes, branding
- `docs/operations/` — database, deploy and production runbooks
- `CONTRIBUTING.md` — workflow and review expectations
