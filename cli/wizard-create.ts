/**
 * Step 4 of the wizard: generate the project through `createProject` (the
 * same code `bun cli/init.ts new` runs), bootstrap its PageSpace drive with
 * a temporary key, record the drive ids and push to GitHub.
 */
import type { Options } from './args';
import { createProject, type Deps as InitDeps } from './init';
import type { Accounts } from './wizard-accounts';
import { act, WizardStop, type WizardDeps } from './wizard-deps';
import { withTemporaryKey } from './wizard-pagespace';
import type { Flags } from './wizard-questions';
import { offersReviewGate, setUpReviewGate } from './wizard-review-app';

const projectOptions = (accounts: Accounts): Options => ({
  target: accounts.target,
  slug: accounts.slug,
  display: accounts.display,
  owner: accounts.owner,
  repo: `${accounts.owner}/${accounts.slug}`,
  without: [],
  drive: false, // the wizard bootstraps the drive itself, with its temporary key
  github: accounts.github,
  visibility: accounts.visibility,
  install: true,
  yes: true, // every action was confirmed in the plan below
});

function planLines(flags: Flags, accounts: Accounts): string[] {
  const repo = `${accounts.owner}/${accounts.slug}`;
  return [
    `Copy the template into ${accounts.target} and name it "${accounts.display}" (${accounts.slug})`,
    'Install its dependencies, generate local secrets and make the first commit',
    ...(accounts.github
      ? [`Create the ${accounts.visibility} GitHub repository ${repo}`]
      : []),
    ...(accounts.drive
      ? [
          `Create the "${accounts.display}" PageSpace drive, using a temporary key that is removed afterwards`,
        ]
      : []),
    ...(accounts.github ? ['Push the code to GitHub (asks first)'] : []),
    ...(offersReviewGate(flags, accounts)
      ? [
          'Set up the review gate, a GitHub App that only lets reviewed PRs merge (asks first; two clicks in your browser)',
        ]
      : []),
    ...(accounts.run
      ? [
          'Start the database and the app on this computer, then open them in your browser',
        ]
      : []),
  ];
}

const DRY_RUN_GENERATE = [
  'copy and rename the template (cli/generate.ts)',
  'git init -q -b main',
  'bun install',
  'bun auth:provision',
  'bunx --bun prettier --log-level=warn --write .   (until --check passes)',
  'bunx --bun jscpd --reporters=silent --update-baseline   (source and test baselines)',
  'git add -A && git commit -q -m "chore: initialize <slug> from init-offense"',
];

function generate(deps: WizardDeps, flags: Flags, accounts: Accounts): void {
  const options = projectOptions(accounts);
  if (flags.dryRun) {
    for (const line of DRY_RUN_GENERATE)
      deps.log(`  [dry run] ${line.replace('<slug>', accounts.slug)}`);
    if (accounts.github)
      deps.log(
        `  [dry run] gh repo create ${options.repo} --${options.visibility} --source ${options.target} --remote origin`,
      );
    return;
  }
  const initDeps: InitDeps = {
    run: (command, args, cwd) => deps.runner.run([command, ...args], { cwd }),
    ghLogin: () => accounts.owner,
    confirm: () => true,
    log: deps.log,
  };
  if (createProject(options, initDeps) !== 0)
    throw new WizardStop(
      `Creating the project failed (see the output above). Delete ${accounts.target} and run this again.`,
    );
}

const bootstrapCommand = (github: boolean) => [
  'bun',
  'scripts/drive-bootstrap.ts',
  ...(github ? ['--github'] : []),
];

/** Returns true when the drive exists and its ids are committed. */
async function bootstrapDrive(
  deps: WizardDeps,
  flags: Flags,
  accounts: Accounts,
): Promise<boolean> {
  const cwd = accounts.target;
  try {
    const code = await withTemporaryKey(
      deps,
      accounts.slug,
      flags.dryRun,
      (token) =>
        act(deps, flags.dryRun, bootstrapCommand(accounts.github), {
          cwd,
          env: { PAGESPACE_BOOTSTRAP_TOKEN: token },
        }),
    );
    if (code !== 0)
      throw new Error(`the drive bootstrap failed (exit ${code})`);
  } catch (error) {
    deps.log(
      `\nThe PageSpace drive was not finished: ${(error as Error).message}.`,
    );
    deps.log(
      `Your app still works. To retry later in ${cwd}: mint a key with ` +
        '`pagespace keys create --all-drives --name <name> --show-token`, run ' +
        `\`PAGESPACE_BOOTSTRAP_TOKEN=<that token> ${bootstrapCommand(accounts.github).join(' ')}\`, ` +
        'then revoke the key with `pagespace keys revoke <id>`.',
    );
    return false;
  }
  const changed =
    flags.dryRun ||
    deps.runner
      .probe(['git', 'status', '--porcelain'], { cwd })
      .stdout.trim() !== '';
  if (changed) {
    act(deps, flags.dryRun, ['git', 'add', '-A'], { cwd });
    act(
      deps,
      flags.dryRun,
      ['git', 'commit', '-q', '-m', 'chore: record the PageSpace drive'],
      { cwd },
    );
  }
  return true;
}

async function push(
  deps: WizardDeps,
  flags: Flags,
  accounts: Accounts,
): Promise<boolean> {
  const question = `Push your code to GitHub (${accounts.owner}/${accounts.slug}) now?`;
  if (
    !flags.yes &&
    !flags.dryRun &&
    !(await deps.prompt.confirm(question, true))
  ) {
    deps.log('Skipped. Push later with: git push -u origin main');
    return false;
  }
  const pushed =
    act(deps, flags.dryRun, ['git', 'push', '-u', 'origin', 'main'], {
      cwd: accounts.target,
    }) === 0;
  if (!pushed)
    deps.log('The push failed; retry later with: git push -u origin main');
  return pushed;
}

export type Created = {
  readonly drive: boolean;
  readonly pushed: boolean;
  /** The review-record App is set up and review-record is required. */
  readonly reviewGate: boolean;
};

/** Shows the plan, asks once, then creates everything. */
export async function createEverything(
  deps: WizardDeps,
  flags: Flags,
  accounts: Accounts,
): Promise<Created> {
  deps.log('\n— Step 4 of 5: create —');
  deps.log('Here is what happens next:');
  planLines(flags, accounts).forEach((line, index) =>
    deps.log(`  ${index + 1}. ${line}`),
  );
  if (
    !flags.yes &&
    !flags.dryRun &&
    !(await deps.prompt.confirm('Go ahead?', true))
  )
    throw new WizardStop('Stopped before creating anything.', 0);
  deps.log('');
  generate(deps, flags, accounts);
  const drive = accounts.drive && (await bootstrapDrive(deps, flags, accounts));
  const pushed = accounts.github && (await push(deps, flags, accounts));
  const reviewGate = await setUpReviewGate(deps, flags, accounts, pushed);
  return { drive, pushed, reviewGate };
}
