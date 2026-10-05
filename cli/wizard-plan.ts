/**
 * Pure planning for `bun cli/wizard.ts`: slug suggestions, which tools a
 * run needs, and how each missing tool is installed on each platform.
 * No I/O; every decision here is a table the tests pin.
 */
import type { Visibility } from './args';
import { slugProblem } from './rename';

export type Command = readonly string[];

/** A slug that passes cli/args rules, derived from a display name. */
export function suggestSlug(display: string): string {
  const words = display
    .toLowerCase()
    .replace(/acme/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const slug = (/^[0-9]/.test(words) ? `app-${words}` : words)
    .slice(0, 30)
    .replace(/-+$/, '');
  return slug === '' || slugProblem(slug) !== null ? 'my-app' : slug;
}

export type Tool = 'git' | 'docker' | 'gh' | 'pagespace';

export type Need = {
  readonly tool: Tool;
  readonly label: string;
  readonly why: string;
};

export type Choices = {
  readonly github: boolean;
  readonly drive: boolean;
  readonly run: boolean;
};

const NEEDS: Readonly<Record<Tool, Need>> = {
  git: { tool: 'git', label: 'Git', why: 'tracks your project history' },
  docker: {
    tool: 'docker',
    label: 'Docker',
    why: 'runs the database and Redis your app uses locally',
  },
  gh: {
    tool: 'gh',
    label: 'GitHub CLI (gh)',
    why: 'creates your GitHub repository',
  },
  pagespace: {
    tool: 'pagespace',
    label: 'PageSpace CLI',
    why: "signs you in to PageSpace and creates your project's drive",
  },
};

/** The tools this run needs, in the order they are checked. */
export function neededTools(choices: Choices): Need[] {
  const tools: Tool[] = ['git'];
  if (choices.run) tools.push('docker');
  if (choices.github) tools.push('gh');
  if (choices.drive) tools.push('pagespace');
  return tools.map((tool) => NEEDS[tool]);
}

export type Host = {
  readonly platform: string;
  readonly hasBrew: boolean;
  readonly packageManager: 'apt' | 'dnf' | null;
};

export type InstallPlan =
  | {
      readonly kind: 'commands';
      readonly commands: readonly Command[];
      readonly note?: string;
    }
  | { readonly kind: 'manual'; readonly lines: readonly string[] };

const PAGESPACE_INSTALL: InstallPlan = {
  kind: 'commands',
  commands: [['bun', 'add', '-g', '@pagespace/cli']],
};

const WINDOWS: InstallPlan = {
  kind: 'manual',
  lines: [
    'On Windows this template runs inside WSL (a Linux environment built into Windows).',
    'Open PowerShell as Administrator and run: wsl --install',
    'Restart, open the "Ubuntu" app, and run this command again there.',
  ],
};

const MANUAL_URLS: Readonly<Record<Exclude<Tool, 'pagespace'>, string>> = {
  git: 'https://git-scm.com/downloads',
  docker:
    'https://orbstack.dev (or Docker Desktop: https://docs.docker.com/get-docker/)',
  gh: 'https://cli.github.com',
};

const manual = (tool: Exclude<Tool, 'pagespace'>): InstallPlan => ({
  kind: 'manual',
  lines: [
    `Install ${NEEDS[tool].label} from ${MANUAL_URLS[tool]}, then come back here.`,
  ],
});

function macPlan(tool: Exclude<Tool, 'pagespace'>, host: Host): InstallPlan {
  if (tool === 'git' && !host.hasBrew)
    return {
      kind: 'commands',
      commands: [['xcode-select', '--install']],
      note: 'A macOS dialog opens; click Install and wait for it to finish.',
    };
  if (!host.hasBrew) return manual(tool);
  if (tool === 'docker')
    return {
      kind: 'commands',
      commands: [['brew', 'install', '--cask', 'orbstack']],
      note: 'OrbStack is a light Docker app for macOS (Docker Desktop works too). Open it once after installing.',
    };
  return { kind: 'commands', commands: [['brew', 'install', tool]] };
}

function linuxPlan(tool: Exclude<Tool, 'pagespace'>, host: Host): InstallPlan {
  if (tool === 'docker')
    return {
      kind: 'commands',
      commands: [['sh', '-c', 'curl -fsSL https://get.docker.com | sudo sh']],
      note: 'Afterwards run `sudo usermod -aG docker $USER` and log out and back in so Docker works without sudo.',
    };
  if (host.packageManager === null) return manual(tool);
  const manager = host.packageManager === 'apt' ? 'apt-get' : 'dnf';
  return {
    kind: 'commands',
    commands: [['sudo', manager, 'install', '-y', tool]],
    note: 'This uses sudo, so it may ask for your computer password.',
  };
}

/** How a missing tool is installed on this host. */
export function installPlan(tool: Tool, host: Host): InstallPlan {
  if (tool === 'pagespace') return PAGESPACE_INSTALL;
  if (host.platform === 'win32') return WINDOWS;
  if (host.platform === 'darwin') return macPlan(tool, host);
  if (host.platform === 'linux') return linuxPlan(tool, host);
  return manual(tool);
}

/** Commands that start an installed-but-stopped Docker app (macOS only). */
export function dockerStartCommands(platform: string): Command[] {
  if (platform !== 'darwin') return [];
  return [
    ['open', '-ga', 'OrbStack'],
    ['open', '-ga', 'Docker'],
  ];
}

/** `open` / `xdg-open` / `start` for the platform. */
export function openerCommand(platform: string, url: string): Command {
  if (platform === 'darwin') return ['open', url];
  if (platform === 'win32') return ['cmd', '/c', 'start', '', url];
  return ['xdg-open', url];
}

export type DockerState = 'missing' | 'stopped' | 'running';

/** `docker --version` says installed; only `docker info` proves it runs. */
export const dockerState = (installed: boolean, info: boolean): DockerState => {
  if (!installed) return 'missing';
  return info ? 'running' : 'stopped';
};

/** Shell-style rendering of a command for display (never holds a secret). */
export const shown = (command: Command): string =>
  command
    .map((part) =>
      /^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, "'\\''")}'`,
    )
    .join(' ');

/** `gh api user --jq .plan.name` output as a plan name, or null. */
export const githubPlan = (code: number, stdout: string): string | null => {
  const plan = stdout.trim().toLowerCase();
  return code === 0 && /^[a-z_ -]+$/.test(plan) ? plan : null;
};

/**
 * The suggested repository visibility: public on a free GitHub plan (free
 * Actions minutes, and branch rulesets GitHub only enforces on public repos
 * there), private on a paid plan or when the plan is unknown.
 */
export const defaultVisibility = (plan: string | null): Visibility =>
  plan === 'free' ? 'public' : 'private';

/** The trade-off, in plain words, shown before the question. */
export function visibilityExplanation(plan: string | null): string[] {
  return [
    '\nYour GitHub repository can be public or private:',
    '  • Public: anyone can read your code. CI minutes are free, and the merge',
    '    rules (checks and a review must pass before merging) are enforced.',
    '  • Private: only you, and people you invite, can see it. On a free GitHub',
    "    plan the merge rules can't be enforced and CI minutes are limited.",
    ...(plan === null
      ? [
          '  Could not read your GitHub plan (gh needs the read:user scope:',
          '  gh auth refresh -s read:user), so private is suggested. If your plan',
          '  is free, public is usually the better choice.',
        ]
      : [
          `  Your GitHub plan: ${plan}, so ${defaultVisibility(plan)} is suggested.`,
        ]),
  ];
}

/**
 * The warning for a private repository on a free plan (or on a plan gh
 * could not read, worded as a condition), with its fix.
 */
export function privateOnFreeNote(
  repo: string,
  visibility: Visibility,
  plan: string | null,
): string[] {
  if (visibility !== 'private' || (plan !== 'free' && plan !== null)) return [];
  return [
    plan === 'free'
      ? `\nNote: ${repo} is private on a free GitHub plan, so its merge rules`
      : `\nNote: if your GitHub plan is free, ${repo} being private means its merge rules`,
    '(`bun github:rules --apply`) cannot be enforced and CI minutes are limited.',
    `To make it public: gh repo edit ${repo} --visibility public --accept-visibility-change-consequences`,
    '(or upgrade to GitHub Pro).',
  ];
}
