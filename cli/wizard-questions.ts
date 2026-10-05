/**
 * Wizard flags and the project questions (welcome and step 2). A flag
 * always wins over a question; `--yes` takes every default without asking.
 */
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Visibility } from './args';
import { targetProblem } from './copy';
import { defaultDisplay, displayProblem, slugProblem } from './rename';
import { WizardStop, type WizardDeps } from './wizard-deps';
import {
  defaultVisibility,
  githubPlan,
  suggestSlug,
  visibilityExplanation,
} from './wizard-plan';

export type Flags = {
  readonly dir?: string | undefined;
  readonly name?: string | undefined;
  readonly display?: string | undefined;
  readonly owner?: string | undefined;
  readonly github?: boolean | undefined;
  readonly visibility?: Visibility | undefined;
  readonly drive?: boolean | undefined;
  readonly run?: boolean | undefined;
  readonly yes: boolean;
  readonly dryRun: boolean;
};

export type Answers = {
  readonly display: string;
  readonly slug: string;
  readonly target: string;
  readonly github: boolean;
  /** The repository's visibility; meaningful only when `github`. */
  readonly visibility: Visibility;
  /** The signed-in GitHub account's plan (free, pro, …) when known. */
  readonly plan: string | null;
  readonly drive: boolean;
  readonly run: boolean;
};

export const WIZARD_USAGE = `Usage: bun cli/wizard.ts [dir] [options]

Creates a new app from the init-offense template, step by step.

Options:
  --name <slug>      short name for code and URLs, e.g. widget-app
  --display <name>   the app's name as people see it, e.g. "Widget App"
  --dir <path>       where to create it (default: ./<slug>)
  --owner <owner>    GitHub account or organization for the repository
  --public           make the GitHub repository public (the default on a
                     free GitHub plan: free CI minutes and enforced merge rules)
  --private          make the GitHub repository private (the default otherwise)
  --no-github        do not create a GitHub repository
  --no-drive         do not create a PageSpace drive
  --no-run           do not start the app at the end
  --yes, -y          accept every default without asking
  --dry-run          show every action without running any of them
  --help, -h         show this help`;

const OWNER = /^[A-Za-z0-9-]+$/;

const OPTIONS = {
  name: { type: 'string' },
  display: { type: 'string' },
  dir: { type: 'string' },
  owner: { type: 'string' },
  github: { type: 'boolean' },
  public: { type: 'boolean' },
  private: { type: 'boolean' },
  drive: { type: 'boolean' },
  run: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y', default: false },
  'dry-run': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

export const ownerProblem = (owner: string): string | null =>
  OWNER.test(owner)
    ? null
    : 'must be a GitHub account or organization name (letters, digits, "-")';

const flagProblem = (flags: Flags): string | null => {
  const checks: [
    string | undefined,
    string,
    (value: string) => string | null,
  ][] = [
    [flags.name, '--name', slugProblem],
    [flags.display, '--display', displayProblem],
    [flags.owner, '--owner', ownerProblem],
  ];
  for (const [value, flag, problem] of checks) {
    const found = value === undefined ? null : problem(value);
    if (found) return `${flag} ${found}`;
  }
  if (flags.visibility && flags.github === false)
    return `--${flags.visibility} needs a GitHub repository; drop --no-github`;
  if (flags.yes && !flags.name && !flags.dir)
    return '--yes needs --name <slug> or a directory to name the app after';
  return null;
};

const visibilityFlag = (values: {
  public?: boolean | undefined;
  private?: boolean | undefined;
}): Visibility | undefined => {
  if (values.public) return 'public';
  return values.private ? 'private' : undefined;
};

/** Parses wizard argv into flags, help or a plain-language error. */
export function parseWizardFlags(
  argv: readonly string[],
): { flags: Flags } | { help: true } | { error: string } {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      allowNegative: true,
      options: OPTIONS,
    });
  } catch (error) {
    return { error: (error as Error).message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (positionals.length > 1)
    return { error: `unexpected arguments: ${positionals.slice(1).join(' ')}` };
  if (values.public && values.private)
    return { error: '--public and --private cannot be used together' };
  const flags: Flags = {
    dir: values.dir ?? positionals[0],
    name: values.name,
    display: values.display,
    owner: values.owner,
    github: values.github,
    visibility: visibilityFlag(values),
    drive: values.drive,
    run: values.run,
    yes: values.yes,
    dryRun: values['dry-run'],
  };
  const problem = flagProblem(flags);
  return problem ? { error: problem } : { flags };
}

export function welcome(deps: WizardDeps, flags: Flags): void {
  deps.log(`
Welcome! This sets up a new web app on your computer, ready to sign in to.

What happens, step by step (each step is shown before it runs):
  1. A few questions about your app
  2. A check that the tools it needs are installed (and help installing them)
  3. Sign-in to GitHub and PageSpace, if you use them
  4. Creating the project, its GitHub repository and its PageSpace drive
  5. Starting the app here and opening it in your browser

It usually takes 5 to 10 minutes, mostly installing dependencies.${
    flags.dryRun
      ? '\n\nDRY RUN: nothing will be installed, created or changed.'
      : ''
  }`);
}

const defaultName = (flags: Flags): string | undefined =>
  flags.name ?? (flags.dir ? suggestSlug(basename(flags.dir)) : undefined);

async function askDisplay(deps: WizardDeps, flags: Flags): Promise<string> {
  if (flags.display) return flags.display;
  const fallback = flags.name
    ? defaultDisplay(flags.name)
    : defaultDisplay(defaultName(flags) ?? 'my-app');
  // Code is never made public without an explicit choice: --yes keeps it
  // private, and the summary explains how to make it public.
  if (flags.yes) return 'private';
  return deps.prompt.text('What is your app called?', fallback, displayProblem);
}

async function askSlug(
  deps: WizardDeps,
  flags: Flags,
  display: string,
): Promise<string> {
  if (flags.name) return flags.name;
  const fallback = flags.dir
    ? (defaultName(flags) ?? suggestSlug(display))
    : suggestSlug(display);
  if (flags.yes) return fallback;
  deps.log(
    '\nYour app also needs a short name for code, URLs and the database (lowercase, no spaces).',
  );
  return deps.prompt.text('Short name', fallback, slugProblem);
}

async function askTarget(
  deps: WizardDeps,
  flags: Flags,
  slug: string,
): Promise<string> {
  const check = (path: string) => targetProblem(resolve(deps.cwd, path));
  if (flags.dir || flags.yes) {
    const target = resolve(deps.cwd, flags.dir ?? slug);
    const problem = check(target);
    if (problem)
      throw new WizardStop(`${problem}. Choose another directory.`, 2);
    return target;
  }
  return resolve(
    deps.cwd,
    await deps.prompt.text('Which folder should it go in?', `./${slug}`, check),
  );
}

const askYes = (
  deps: WizardDeps,
  flags: Flags,
  value: boolean | undefined,
  question: string,
) =>
  value !== undefined || flags.yes
    ? Promise.resolve(value ?? true)
    : deps.prompt.confirm(question, true);

/** The signed-in account's GitHub plan, when gh can already tell. */
export const probePlan = (deps: WizardDeps): string | null => {
  const { code, stdout } = deps.runner.probe([
    'gh',
    'api',
    'user',
    '--jq',
    '.plan.name',
  ]);
  return githubPlan(code, stdout);
};

async function askVisibility(
  deps: WizardDeps,
  flags: Flags,
  plan: string | null,
): Promise<Visibility> {
  if (flags.visibility) return flags.visibility;
  const fallback = defaultVisibility(plan);
  visibilityExplanation(plan).forEach((line) => deps.log(line));
  // Code is never made public without an explicit choice: --yes keeps it
  // private, and the summary explains how to make it public.
  if (flags.yes) return 'private';
  return deps.prompt.select<Visibility>(
    'Should the repository be public or private?',
    [
      { value: 'public', label: 'Public' },
      { value: 'private', label: 'Private' },
    ],
    fallback,
  );
}

/** Step 1: what to create and where. */
export async function askProject(
  deps: WizardDeps,
  flags: Flags,
): Promise<Answers> {
  deps.log('\n— Step 1 of 5: your app —');
  const display = await askDisplay(deps, flags);
  const slug = await askSlug(deps, flags, display);
  const target = await askTarget(deps, flags, slug);
  const github = await askYes(
    deps,
    flags,
    flags.github,
    'Create a GitHub repository for it? (recommended; GitHub stores your code online)',
  );
  const plan = github ? probePlan(deps) : null;
  const visibility = github
    ? await askVisibility(deps, flags, plan)
    : 'private';
  const drive = await askYes(
    deps,
    flags,
    flags.drive,
    'Create a PageSpace drive for it? (recommended; it holds the roadmap, plans and AI agents)',
  );
  deps.log(`  App: "${display}" (${slug}) in ${target}`);
  deps.log(
    `  GitHub repository: ${github ? `yes, ${visibility}` : 'no'}; PageSpace drive: ${drive ? 'yes' : 'no'}`,
  );
  return {
    display,
    slug,
    target,
    github,
    visibility,
    plan,
    drive,
    run: flags.run ?? true,
  };
}
