/**
 * Step 3 of the wizard: make sure the person is signed in to GitHub and
 * PageSpace (as their answers need), and settle the repository owner.
 */
import { act, WizardStop, type WizardDeps } from './wizard-deps';
import {
  ownerProblem,
  probePlan,
  type Answers,
  type Flags,
} from './wizard-questions';

const PAGESPACE_URL = 'https://pagespace.ai';
const PAGESPACE_SIGNUP_URL = `${PAGESPACE_URL}/auth/signup`;

export type Accounts = Answers & { readonly owner: string };

/** True when `pagespace whoami --json` reports a personal login. */
export function hasPersonalLogin(code: number, stdout: string): boolean {
  if (code !== 0) return false;
  try {
    return (
      (JSON.parse(stdout) as { personalLogin?: unknown }).personalLogin === true
    );
  } catch {
    return false;
  }
}

function githubLogin(deps: WizardDeps): string | null {
  const { code, stdout } = deps.runner.probe([
    'gh',
    'api',
    'user',
    '--jq',
    '.login',
  ]);
  const login = stdout.trim();
  return code === 0 && login !== '' ? login : null;
}

async function signInToGithub(deps: WizardDeps, flags: Flags): Promise<void> {
  if (deps.runner.probe(['gh', 'auth', 'status']).code === 0) {
    deps.log('  ✓ Signed in to GitHub');
    return;
  }
  deps.log(
    '\nSign in to GitHub. A browser window opens; follow the steps there.',
  );
  if (
    act(deps, flags.dryRun, [
      'gh',
      'auth',
      'login',
      '--web',
      '--git-protocol',
      'https',
      // read:user lets `gh api user` report the plan (free, pro, …).
      '--scopes',
      'read:user',
    ]) !== 0
  )
    throw new WizardStop(
      'GitHub sign-in did not finish. Run this again, or use --no-github.',
    );
}

async function chooseOwner(deps: WizardDeps, flags: Flags): Promise<string> {
  if (flags.owner) return flags.owner;
  const login = githubLogin(deps);
  if (flags.yes || flags.dryRun) {
    if (login) return login;
    if (flags.dryRun) return '<your-github-login>';
    throw new WizardStop(
      'Could not read your GitHub login; pass --owner <account>.',
    );
  }
  return deps.prompt.text(
    'Which GitHub account or organization should own the repository?',
    login ?? '',
    ownerProblem,
  );
}

async function signUpToPagespace(
  deps: WizardDeps,
  flags: Flags,
): Promise<void> {
  if (flags.yes) return;
  const account = await deps.prompt.select(
    'Do you have a PageSpace account?',
    [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No, open the sign-up page (free)' },
    ],
    'yes',
  );
  if (account === 'yes') return;
  deps.log(`  Opening ${PAGESPACE_SIGNUP_URL}`);
  if (!flags.dryRun) deps.open(PAGESPACE_SIGNUP_URL);
  await deps.prompt.pause('Press Enter once you have created your account…');
}

async function signInToPagespace(
  deps: WizardDeps,
  flags: Flags,
): Promise<void> {
  deps.log(
    '\nPageSpace is an online workspace where your project keeps its roadmap, plans and AI agents.',
  );
  await signUpToPagespace(deps, flags);
  const { code, stdout } = deps.runner.probe(['pagespace', 'whoami', '--json']);
  if (hasPersonalLogin(code, stdout)) {
    deps.log('  ✓ Signed in to PageSpace');
    return;
  }
  deps.log(
    'Sign in to PageSpace. A browser window opens; approve the sign-in there.',
  );
  if (act(deps, flags.dryRun, ['pagespace', 'login']) !== 0)
    throw new WizardStop(
      'PageSpace sign-in did not finish. Run this again, or use --no-drive.',
    );
}

/** Signs in where needed and returns the answers with the GitHub owner. */
export async function connectAccounts(
  deps: WizardDeps,
  flags: Flags,
  answers: Answers,
): Promise<Accounts> {
  deps.log('\n— Step 3 of 5: accounts —');
  // Recorded in project.config.json even without a repository.
  let owner =
    flags.owner ?? (answers.github ? '' : (githubLogin(deps) ?? 'local'));
  if (!answers.github && !answers.drive) {
    deps.log(
      '  No accounts needed (no GitHub repository, no PageSpace drive).',
    );
    return { ...answers, owner };
  }
  let { plan } = answers;
  if (answers.github) {
    await signInToGithub(deps, flags);
    owner = await chooseOwner(deps, flags);
    plan ??= probePlan(deps); // gh may only now be installed and signed in
  }
  if (answers.drive) await signInToPagespace(deps, flags);
  return { ...answers, owner, plan };
}
