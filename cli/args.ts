/** Command-line parsing for `bun cli/init.ts new` (pure apart from `ghLogin`). */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { defaultDisplay, displayProblem, slugProblem } from './rename';

const FALLBACK_OWNER = '2witstudios';
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export type Visibility = 'public' | 'private';

export type Options = {
  readonly target: string;
  readonly slug: string;
  readonly display: string;
  readonly owner: string;
  readonly repo: string;
  readonly without: readonly string[];
  readonly drive: boolean;
  readonly github: boolean;
  /** The GitHub repository's visibility (default private). */
  readonly visibility: Visibility;
  readonly install: boolean;
  readonly yes: boolean;
};

export type Parsed = { options: Options } | { error: string } | { help: true };

export const USAGE = `Usage: bun cli/init.ts new <dir> --name <slug> [options]

Options:
  --name <slug>        lowercase project slug (required), e.g. widget-app
  --display <name>     display name for prose (default: title-cased slug)
  --owner <owner>      GitHub owner (default: gh api user, else ${FALLBACK_OWNER})
  --repo <owner/name>  GitHub repository (default: <owner>/<slug>)
  --without <list>     comma-separated modules to drop (see cli/modules.json)
  --no-install         skip git init, bun install, auth:provision and the first commit
  --public             create a public GitHub repository (free CI minutes and
                       enforceable merge rules on a free GitHub plan)
  --private            create a private GitHub repository (the default)
  --no-github          skip creating the GitHub repository
  --no-drive           skip the PageSpace drive bootstrap
  --yes, -y            do not ask for confirmation
  --help, -h           show this help`;

const OPTIONS = {
  name: { type: 'string' },
  display: { type: 'string' },
  owner: { type: 'string' },
  repo: { type: 'string' },
  without: { type: 'string', default: '' },
  drive: { type: 'boolean', default: true },
  github: { type: 'boolean', default: true },
  public: { type: 'boolean', default: false },
  private: { type: 'boolean', default: false },
  install: { type: 'boolean', default: true },
  yes: { type: 'boolean', short: 'y', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

const parse = (argv: readonly string[]) =>
  parseArgs({
    args: [...argv],
    allowPositionals: true,
    allowNegative: true,
    options: OPTIONS,
  });

type Values = ReturnType<typeof parse>['values'];

const positionalProblem = (positionals: readonly string[]): string | null => {
  const [command, target, ...extra] = positionals;
  if (command !== 'new') return 'expected the "new" command';
  if (!target) return 'missing <dir>';
  return extra.length > 0 ? `unexpected arguments: ${extra.join(' ')}` : null;
};

const identityProblem = (values: Values): string | null => {
  const badSlug = slugProblem(values.name ?? '');
  if (badSlug) return `--name ${badSlug}`;
  const badDisplay = displayProblem(
    values.display ?? defaultDisplay(values.name ?? ''),
  );
  if (badDisplay) return `--display ${badDisplay}`;
  if (values.public && values.private)
    return '--public and --private cannot be used together';
  return values.repo !== undefined && !REPO.test(values.repo)
    ? `--repo must match ${REPO}`
    : null;
};

const toOptions = (
  values: Values,
  target: string,
  ghLogin: () => string | null,
): Options => {
  const slug = values.name ?? '';
  const owner =
    values.owner ?? values.repo?.split('/')[0] ?? ghLogin() ?? FALLBACK_OWNER;
  return {
    target: resolve(target),
    slug,
    display: values.display ?? defaultDisplay(slug),
    owner,
    repo: values.repo ?? `${owner}/${slug}`,
    without: values.without
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
    drive: values.drive,
    github: values.github,
    visibility: values.public ? 'public' : 'private',
    install: values.install,
    yes: values.yes,
  };
};

/** Parses argv (without `bun cli/init.ts`) into options, help or an error. */
export function parseCli(
  argv: readonly string[],
  ghLogin: () => string | null,
): Parsed {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    return { error: (error as Error).message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  const problem = positionalProblem(positionals) ?? identityProblem(values);
  if (problem) return { error: problem };
  return { options: toOptions(values, positionals[1] ?? '', ghLogin) };
}
