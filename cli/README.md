# init-offense CLI

Generates a new project from this template, either guided (the wizard) or
non-interactively (`init.ts new`).

## The wizard

```sh
bun cli/wizard.ts [dir] [--name <slug>] [--display <name>] [--dir <path>] \
  [--owner <owner>] [--public | --private] [--no-github] [--no-drive] [--no-run] \
  [--no-review-app] [--yes] [--dry-run]
```

`init-offense my-app` (the npm package in `create/`, also `npx init-offense`) checks Git and
Bun, offers to install Bun with the official installer, shallow-clones this
repository (`INIT_OFFENSE_TEMPLATE` or `--template` take a local path or
another Git URL instead) and runs this wizard with the remaining arguments.

Steps, each shown before it runs: questions (`wizard-questions.ts`), a
tool checklist with consented installs (`wizard-prereqs.ts`, decision
table in `wizard-plan.ts`), GitHub and PageSpace sign-in
(`wizard-accounts.ts`), generation through `createProject` from
`init.ts` plus the drive bootstrap and push (`wizard-create.ts`), the
review gate (`wizard-review-app.ts`), and the local run (`wizard-run.ts`, ports and `.env` in `wizard-env.ts`).

- **Temporary key.** The drive bootstrap needs an unscoped key, so the
  wizard runs `pagespace keys create --all-drives --name <slug>-setup
--show-token --yes` (browser consent), reads the single
  `PAGESPACE_TOKEN=mcp_…` stdout line without displaying it, passes it to
  `bun scripts/drive-bootstrap.ts [--github]` as
  `PAGESPACE_BOOTSTRAP_TOKEN`, and in a `finally` revokes it
  (`pagespace keys list --json` → `pagespace keys revoke <id> --yes`) and
  forgets the CLI's local copy (`pagespace logout --key=<slug>-setup`).
  The bootstrap then mints the drive's own Agent key with
  `pagespace keys create --drive …`, a second browser approval: PageSpace
  mints keys only through browser consent (its `POST /api/auth/mcp-tokens`
  accepts a signed-in session, never a key), so the plan says upfront that
  two keys are approved. Of each mint's stderr only the consent lines (the
  browser is opening, a URL to open by hand, a device code, errors) are
  shown; the CLI's post-mint MCP-client tips are not, unless the mint
  fails (`scripts/pagespace-consent.ts`).
- **Ports.** Postgres from 15432, Redis from 6379, the app from 3000 and
  realtime from 3011, each moved up to the next free port. The stack ports
  go to `.env` as `<SLUG>_POSTGRES_PORT` / `<SLUG>_REDIS_PORT` with every
  Postgres and Redis URL before `bun slot:up`; a moved app port is written
  after it, because `slot:up` resets the main checkout's app ports.
- **Visibility.** When GitHub is chosen, step 1 probes
  `gh api user --jq .plan.name` (read-only; re-probed after sign-in when
  gh could not answer yet). GitHub reports the plan only to a token with
  the `read:user` scope, which `gh auth login` does not grant by default:
  the wizard's own sign-in asks for it, and an existing login can add it
  with `gh auth refresh -s read:user`. It then explains the trade-off and asks
  `Should the repository be public or private?`. The suggestion
  (`defaultVisibility` in `wizard-plan.ts`) is public on `free` and private
  otherwise; `--yes` never makes code public (it creates a private repository and the summary prints the one-line fix), `--public` / `--private` (mutually exclusive,
  refused with `--no-github`) skip the question. On a free plan GitHub
  enforces rulesets only on public repositories (`bun github:rules --apply`
  answers 403 "Upgrade to GitHub Pro" on a private one) and Actions minutes
  are free only there, so a private repository on `free` (or on a plan gh
  could not read, worded "if your GitHub plan is free") gets a note in the
  final summary with the one-line fix:
  `gh repo edit <owner>/<slug> --visibility public --accept-visibility-change-consequences`.
- **Review gate.** After the push the wizard asks "Set up the review
  gate (a small GitHub App that only lets reviewed PRs merge)? It needs
  two clicks in your browser." (default yes; `--yes` says yes,
  `--no-review-app` skips it) and runs the new project's
  `bun github:review-app` attached to the terminal: the manifest flow,
  the key stored in the main-only `review-record` environment, the
  install, `REVIEW_RECORD_APP_ID`, then `bun github:rules --apply`
  ([review record](../docs/development/review-record.md#setting-up-the-review-record-app)).
  The dry run prints the same steps from `reviewAppSteps` in
  `scripts/github-review-app-plan.ts`; a failure or a skip leaves the app
  working and puts the command in the summary's next steps.
- **Dry run.** `--dry-run` still runs read-only probes (versions,
  `docker info`, `gh auth status`, `pagespace whoami`) but executes,
  writes and opens nothing.
- **No terminal.** Without a TTY every question fails with the flag to pass;
  `--yes --name <slug>` answers all of them.

## `init.ts new`

```sh
bun cli/init.ts new <dir> --name <slug> [--display "Widget"] [--repo owner/name] \
  [--owner <gh owner>] [--without realtime,docs] [--public | --private] \
  [--no-drive] [--no-github] [--no-install] [--yes]
```

| Flag                  | Meaning                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name <slug>`       | Required. `^[a-z][a-z0-9-]{0,29}$` (at most 30 chars, so worktree slot names fit Postgres), no `--`, no trailing `-`, must not contain `acme`. |
| `--display <name>`    | Display name used in prose. Defaults to the title-cased slug (`widget-app` → `Widget App`). Letters, digits, spaces, `.`, `&`, `-`.            |
| `--owner <owner>`     | GitHub owner. Defaults to the owner in `--repo`, then `gh api user --jq .login`, then `2witstudios`.                                           |
| `--repo <owner/name>` | GitHub repository. Defaults to `<owner>/<slug>`.                                                                                               |
| `--without <list>`    | Drop modules declared in `cli/modules.json` (experimental, see below).                                                                         |
| `--no-install`        | Skip `git init -b main`, `bun install`, `bun auth:provision` and the first commit.                                                             |
| `--public`            | Create the repository public (free Actions minutes and enforceable rulesets on a free GitHub plan). Not with `--private`.                      |
| `--private`           | Create the repository private (the default).                                                                                                   |
| `--no-github`         | Skip `gh repo create <repo> --private\|--public --source <dir> --remote origin`.                                                               |
| `--no-drive`          | Skip `bun scripts/drive-bootstrap.ts`.                                                                                                         |
| `--yes`               | Do not ask before creating the GitHub repository or the drive.                                                                                 |

`<dir>` must not exist or must be empty.

## What it does

1. **Copy.** The file list is `git ls-files --cached --others --exclude-standard`
   of the template (a filesystem walk when the template is not a git
   repository), minus `.git`, `cli/`, `create/`, `node_modules`, `.turbo`, `.next`,
   `verify-logs`, `test-results`, `playwright-report`, `.env`, `.env.local`,
   `.env.agent`, `.pu/*` (except `config.yaml` and `agent-context.md`),
   `.claude/worktrees` and `*.tsbuildinfo`. Binary files (a NUL byte in the
   first 8 KiB) are copied untouched; modes and symlinks are preserved.
2. **Rename** every `acme` in text and in file and directory names
   (`cli/rename.ts`, pure):

   | Template                                                                                       | Context                                                                   | Becomes (`--name widget-app --display "Widget App"`)                                  |
   | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
   | `ACME_E2E_LOCK_DIR`                                                                            | all caps                                                                  | `WIDGET_APP_E2E_LOCK_DIR`                                                             |
   | `AcmeMark`, `isAcmeDbRefusal`                                                                  | capitalized, glued to an identifier char, `@`, `/`, `\`, `-` or a `.name` | `WidgetAppMark`, `isWidgetAppDbRefusal`                                               |
   | `Player@Acme.example.com`, `www.Acme.dev`                                                      | capitalized, a whole hostname label                                       | `Player@Widget-app.example.com` (hostnames ignore case, so it stays the slug)         |
   | `"Acme"`, `Sign in to Acme`, `Acme's`                                                          | capitalized, in prose                                                     | `"Widget App"`, `Sign in to Widget App`, `Widget App's`                               |
   | `holder.acmeWebApp`, `__acmeRealtime`                                                          | lowercase before an uppercase letter                                      | `holder.widgetAppWebApp`, `__widgetAppRealtime`                                       |
   | `acme_web`, `acme_wt_`, `ACME`-free `_acme`                                                    | lowercase next to `_`                                                     | `widget_app_web`, `widget_app_wt_`                                                    |
   | `postgres://acme:pw@h/acme`, `POSTGRES_USER: acme`, `pg_isready -U acme`, `drop database acme` | lowercase in a Postgres context                                           | `postgres://widget_app:pw@h/widget_app`, …                                            |
   | `@acme/web`, `acme-staging`, `x-acme-client-ip`, `acme-mark/`                                  | lowercase anywhere else                                                   | `@widget-app/web`, `widget-app-staging`, `x-widget-app-client-ip`, `widget-app-mark/` |
   | `2witstudios/acme`                                                                             | the template repo                                                         | the `--repo` value, verbatim                                                          |

   In file and directory names a capitalized `Acme` is always PascalCase.
   `bun.lock` is renamed too; `bun install` regenerates it.

3. **Modules.** `--without` drops the files matching a module's `paths`
   (directory prefixes or globs, matched on template paths), removes
   `package.json` scripts that run a removed file plus any explicit
   `packageJsonEdits` (`{ file, removeScripts?, removeDependencies? }`), and
   prints every remaining reference: relative imports that resolve to a
   removed file, imports of removed packages, and plain mentions. Both
   shipped modules are `experimental`: they are not fully decoupled yet, so
   expect to follow that report by hand.
4. **Config.** `project.config.json` gets `name`, `displayName`, `repo`,
   `owner` and `pagespace.driveName`; every PageSpace id is reset to `null`.
5. **Install** (unless `--no-install`): copies `.env.example` to `.env`,
   `git init -b main`, `bun install`, `bun auth:provision`,
   `git add -A && git commit -m "chore: initialize <slug> from init-offense"`.
6. **GitHub** (unless `--no-github`, confirmed unless `--yes`):
   `gh repo create <repo> --private --source <dir> --remote origin`
   (or `--public`). It does not push or set up the review gate; run
   `git push -u origin main` and then `bun github:review-app` yourself
   (it creates the review-record App and applies the rulesets). On a free
   GitHub plan rulesets apply only to a public repository: on a private
   one it explains why `review-record` is not enforced, and
   `bun github:rules --apply` exits 1 on GitHub's 403 with the fix.
7. **Drive** (unless `--no-drive`, confirmed unless `--yes`):
   `bun scripts/drive-bootstrap.ts`, or an instruction when the script is
   missing.
8. Prints the remaining human steps: the agent machine user and
   `.env.agent`, `bun github:review-app` (the review-record GitHub App),
   `RESEND_API_KEY`, and the Fly apps.

## Tests

```sh
bun test ./cli
```

`cli/generate.test.ts` generates from the real template tree and asserts no
`acme` or `daisy` survives anywhere and that `project.config.json` passes
`parseProjectConfig`.

## Acceptance loop

A template change is done when freshly generated projects still pass every
`bun check` stage except `policy` (which needs the GitHub remote a
`--no-github` project lacks):

```sh
bun cli/verify-generated.ts widget-app
bun cli/verify-generated.ts northwind-logistics-portal --display "Northwind Logistics Portal"
bun cli/verify-generated.ts zed
```

Each run deletes and regenerates `<dir>` (default `~/.cache/init-offense-verify/gen-<slug>`, never `$TMPDIR`, which macOS purges of old-looking files mid-run;
override with `--dir`), runs `format:check`, `lint`, `knip`,
`duplication`, `invariants`, `evidence`, `typecheck`, `test`,
`metrics:check` and `build` in order, writes each stage's output to
`<dir>.logs/<stage>.log` and prints a Markdown results table. It stops at
the first failure unless `--keep-going`; `--stages lint,test` runs a
subset. Keep `<dir>` out of any directory with a `tsconfig.json` above
it: knip's config loader walks up past the project root and fails on a
stray one.

`--e2e` (or `e2e` in `--stages`) adds the browser suite after the other
stages (`cli/verify-e2e.ts`); it needs Docker and the Playwright browsers:

```sh
bun cli/verify-generated.ts widget-app --e2e
```

It picks free host ports probing up from Postgres 25432, Redis 16379 and
app 3200 (clear of the defaults other projects' stacks hold), writes them
to the generated `.env` as `<SCREAMING_SLUG>_POSTGRES_PORT`,
`_REDIS_PORT` and `_APP_PORT` with every stack URL, runs `bun slot:up`
under its own Compose project `verify-<slug>`, then
`bun run test:e2e -- -- --project=chromium --project=firefox` (the second
`--` passes the flags through turbo to Playwright), and finally
`docker compose down --volumes` for that project only, pass or fail. Logs
are `e2e-up.log`, `e2e.log` and `e2e-down.log`. WebKit is left out: on
macOS it follows the system Tab-focus setting
([testing](../docs/development/testing.md#known-limits-of-the-browser-harness)),
and Linux CI already runs it. The three slugs cover a hyphenated name, a long one (wider
identifiers, prettier rewraps, `max-lines` headroom) and a one-word one
(sort order and a slug equal to its own snake form).

Three template rules keep the loop green:

- Files stay well under their `max-lines` limits (split by
  responsibility, never raise the limit): a rename lengthens lines and
  prettier rewraps them.
- A spec that matches the product name with a regex, or compares it in a
  sorted list, reads it from `appConfig.brand.displayName`
  (`apps/web/e2e/support/brand.ts`). The renamer decides by context, and
  inside a regex the placeholder reads as an identifier (`/^Acme$/`
  becomes PascalCase) or a slug (`/continue to acme/i`), not the name the
  app renders; and `Acme home` sorts before `Sign in` where `Widget App
home` does not. Plain prose strings (`'Sign in to Acme'`) rename
  correctly. Only the `e2e` stage catches a slip here.
- Tests never spell a renamed identifier in a form the code does not
  compute. Postgres names are the slug's snake form and Redis namespaces
  its kebab form (`scripts/slot-naming.ts`), so a bare `'acme'` that
  stands for a database is derived (`slotNaming('acme').databaseBase`)
  or glued to `_` (`'acme_production'`), and sorted lists are sorted on
  both sides.
