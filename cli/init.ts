#!/usr/bin/env bun
/**
 * Generate a new project from this template.
 *
 *   bun cli/init.ts new <dir> --name <slug> [--display "Widget"]
 *     [--repo owner/name] [--owner <gh owner>] [--without realtime,docs]
 *     [--no-drive] [--no-github] [--no-install] [--yes]
 *
 * See cli/README.md.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseCli, USAGE, type Options } from './args';
import { targetProblem } from './copy';
import { generateTree, TEMPLATE_ROOT } from './generate';
import {
  loadModules,
  unknownModules,
  type Modules,
  type Reference,
} from './modules';

export type Deps = {
  readonly run: (
    command: string,
    args: readonly string[],
    cwd: string,
  ) => number;
  readonly ghLogin: () => string | null;
  readonly confirm: (question: string) => boolean;
  readonly log: (line: string) => void;
};

const MAX_REFERENCES = 40;

function reportReferences(
  references: readonly Reference[],
  log: Deps['log'],
): void {
  if (references.length === 0) return;
  const imports = references.filter((ref) => ref.kind === 'import');
  const mentions = references.filter((ref) => ref.kind === 'mention');
  log('');
  log(
    `WARNING: ${references.length} remaining reference(s) to removed modules ` +
      `(${imports.length} import(s) that will break the build). Fix these before \`bun check\`:`,
  );
  for (const ref of [...imports, ...mentions].slice(0, MAX_REFERENCES))
    log(`  [${ref.kind}] ${ref.file}:${ref.line} -> ${ref.target}`);
  if (references.length > MAX_REFERENCES)
    log(`  ... and ${references.length - MAX_REFERENCES} more`);
}

const humanSteps = (options: Options): string[] => [
  'Create the agent machine user, give it access to the repository, and fill .env.agent from .env.agent.example.',
  'Create the review-record GitHub App, install it on the repository, and set the REVIEW_RECORD_APP_ID / REVIEW_RECORD_APP_KEY secrets.',
  'Add RESEND_API_KEY (and AUTH_EMAIL_FROM) to .env and to the deploy secrets for magic-link email.',
  `Create the Fly apps (${options.slug}-staging, ${options.slug}-staging-migrate, Postgres, Redis) per docs/operations/deploy-staging.md.`,
  'Run `bun github:rules --apply` once the repository is pushed, then `bun doctor`.',
];

type Context = {
  readonly options: Options;
  readonly deps: Deps;
  /** Set once this run has made the first commit. */
  readonly state: { committed: boolean };
};

const step = (
  { options, deps }: Context,
  label: string,
  command: string,
  args: readonly string[],
): boolean => {
  deps.log(`\n$ ${[command, ...args].join(' ')}   # ${label}`);
  const status = deps.run(command, args, options.target);
  if (status !== 0) deps.log(`  failed (exit ${status}): ${label}`);
  return status === 0;
};

const initRepository = (context: Context): boolean =>
  step(context, 'init repository', 'git', ['init', '-q', '-b', 'main']);

function commitAll(context: Context): boolean {
  context.state.committed =
    step(context, 'stage', 'git', ['add', '-A']) &&
    step(context, 'first commit', 'git', [
      'commit',
      '-q',
      '-m',
      `chore: initialize ${context.options.slug} from init-offense`,
    ]);
  return context.state.committed;
}

const MAX_FORMAT_PASSES = 3;

/**
 * Prettier is not always idempotent after a rename (a member chain that
 * fits on one line only once its argument was reflowed needs a second
 * pass), so the tree is rewritten until `--check` agrees, at most
 * MAX_FORMAT_PASSES times.
 */
function formatUntilSettled(context: Context): boolean {
  for (let pass = 1; pass <= MAX_FORMAT_PASSES; pass += 1) {
    const prettier = (mode: string) => ['--bun', 'prettier', mode, '.'];
    if (
      !step(
        context,
        `format renamed sources, pass ${pass}`,
        'bunx',
        prettier('--write'),
      )
    )
      return false;
    if (step(context, 'check formatting settled', 'bunx', prettier('--check')))
      return true;
  }
  context.deps.log(
    `  formatting did not settle after ${MAX_FORMAT_PASSES} prettier passes`,
  );
  return false;
}

/**
 * Renaming changes line lengths and clone fingerprints, so the new tree is
 * reformatted and the duplication baselines are rewritten for the same
 * clones the template already sanctions (ADR 0026); then the baselines
 * themselves are formatted.
 */
function settleStep(context: Context): boolean {
  return (
    formatUntilSettled(context) &&
    step(context, 'rebaseline source clones', 'bunx', [
      '--bun',
      'jscpd',
      '--update-baseline',
    ]) &&
    step(context, 'rebaseline test clones', 'bunx', [
      '--bun',
      'jscpd',
      '--config',
      '.jscpd-tests.json',
      '--update-baseline',
    ]) &&
    step(context, 'format baselines', 'bunx', [
      '--bun',
      'prettier',
      '--write',
      '.jscpd-baseline.json',
      '.jscpd-tests-baseline.json',
    ])
  );
}

function installStep(context: Context): boolean {
  const cwd = context.options.target;
  if (!existsSync(join(cwd, '.env')) && existsSync(join(cwd, '.env.example')))
    copyFileSync(join(cwd, '.env.example'), join(cwd, '.env'));
  return (
    initRepository(context) &&
    step(context, 'install dependencies', 'bun', ['install']) &&
    step(context, 'provision auth secrets', 'bun', ['auth:provision']) &&
    settleStep(context) &&
    commitAll(context)
  );
}

function githubStep(context: Context): boolean {
  const { options, deps } = context;
  const question = `Create private GitHub repository ${options.repo}?`;
  if (!options.yes && !deps.confirm(question)) {
    deps.log('Skipped GitHub repository creation.');
    return true;
  }
  const hasRepo =
    context.state.committed || existsSync(join(options.target, '.git'));
  if (!hasRepo && !(initRepository(context) && commitAll(context)))
    return false;
  const created = step(context, 'create GitHub repository', 'gh', [
    'repo',
    'create',
    options.repo,
    '--private',
    '--source',
    options.target,
    '--remote',
    'origin',
  ]);
  if (created)
    deps.log(
      'Next: `git push -u origin main`, then run `bun github:rules --apply` in the new project.',
    );
  return created;
}

function driveStep(context: Context): boolean {
  const { options, deps } = context;
  const command = 'bun scripts/drive-bootstrap.ts';
  if (!existsSync(join(options.target, 'scripts', 'drive-bootstrap.ts'))) {
    deps.log(
      `\nDrive bootstrap script not found; once it exists run \`${command}\` in ${options.target}.`,
    );
    return true;
  }
  deps.log(
    `\nDrive bootstrap: \`${command}\` creates the "${options.display}" PageSpace drive and writes its ids to project.config.json.`,
  );
  if (!options.yes && !deps.confirm('Run the PageSpace drive bootstrap now?')) {
    deps.log('Skipped drive bootstrap.');
    return true;
  }
  return step(context, 'bootstrap PageSpace drive', 'bun', [
    'scripts/drive-bootstrap.ts',
  ]);
}

const preflight = (options: Options, modules: Modules): string | null => {
  const unknown = unknownModules(modules, options.without);
  if (unknown.length > 0)
    return `Unknown module(s): ${unknown.join(', ')}. Known: ${Object.keys(modules).join(', ')}`;
  return targetProblem(options.target);
};

function generate(options: Options, modules: Modules, log: Deps['log']): void {
  options.without
    .filter((name) => modules[name]?.experimental)
    .forEach((name) =>
      log(
        `Note: module "${name}" is experimental; removal may leave references behind.`,
      ),
    );
  log(
    `Generating ${options.slug} ("${options.display}", ${options.repo}) in ${options.target}`,
  );
  const generated = generateTree(options, TEMPLATE_ROOT, modules);
  log(
    `Copied ${generated.files.length} files; removed ${generated.removed.length} module file(s).`,
  );
  generated.dropped.forEach((line) => log(`  dropped ${line}`));
  reportReferences(generated.references, log);
}

/**
 * Generates, installs, creates the GitHub repository and bootstraps the
 * drive as `options` enable, without the closing summary. Returns a process
 * exit code. `bun cli/wizard.ts` calls this directly.
 */
export function createProject(
  options: Options,
  deps: Deps,
  modules: Modules = loadModules(),
): number {
  const problem = preflight(options, modules);
  if (problem) {
    deps.log(problem);
    return 2;
  }
  generate(options, modules, deps.log);
  const context: Context = { options, deps, state: { committed: false } };
  const steps: readonly [boolean, (context: Context) => boolean][] = [
    [options.install, installStep],
    [options.github, githubStep],
    [options.drive, driveStep],
  ];
  return steps.every(([enabled, run]) => !enabled || run(context)) ? 0 : 1;
}

/** Runs the whole flow. Returns a process exit code. */
function runNew(options: Options, deps: Deps): number {
  const code = createProject(options, deps);
  if (code !== 0) return code;
  deps.log(`\nDone: ${options.target}`);
  deps.log('Remaining human steps:');
  humanSteps(options).forEach((line, index) =>
    deps.log(`  ${index + 1}. ${line}`),
  );
  return 0;
}

const defaultDeps: Deps = {
  run: (command, args, cwd) =>
    spawnSync(command, [...args], { cwd, stdio: 'inherit' }).status ?? 1,
  ghLogin: () => {
    const result = spawnSync('gh', ['api', 'user', '--jq', '.login'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    const login = result.status === 0 ? result.stdout.trim() : '';
    return login === '' ? null : login;
  },
  confirm: (question) => globalThis.confirm(question),
  log: (line) => process.stdout.write(`${line}\n`),
};

export function main(
  argv: readonly string[],
  deps: Deps = defaultDeps,
): number {
  const parsed = parseCli(argv, deps.ghLogin);
  if ('help' in parsed) {
    deps.log(USAGE);
    return 0;
  }
  if ('error' in parsed) {
    deps.log(`Error: ${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  return runNew(parsed.options, deps);
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
