/**
 * create-init-offense: make sure Bun and Git exist, fetch the init-offense
 * template, and hand over to its guided setup (`bun cli/wizard.ts`).
 *
 * Plain ESM for Node 18+, no dependencies, so `npx` works on a machine
 * that has no Bun yet. Every effect comes in through `deps`, so the tests
 * run the whole flow with fakes.
 */
import { delimiter, dirname, join, resolve } from 'node:path';

export const DEFAULT_TEMPLATE = 'https://github.com/2witstudios/init-offense';

const BANNER = `
  init-offense
  A new web app with sign-in, a database and an AI-ready workflow, set up for you.
`;

/** Pulls `--template <path|url>` out of argv; everything else is forwarded. */
export function splitArgs(argv) {
  const forwarded = [];
  let template;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--template') {
      template = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--template=')) {
      template = arg.slice('--template='.length);
    } else {
      forwarded.push(arg);
    }
  }
  return { template, forwarded };
}

/**
 * The template to use: `--template`, then INIT_OFFENSE_TEMPLATE, then the
 * public repository. An existing directory is used in place; anything else
 * is cloned.
 */
export function resolveTemplate(flag, env, isDirectory) {
  const value = flag || env.INIT_OFFENSE_TEMPLATE || DEFAULT_TEMPLATE;
  return isDirectory(value)
    ? { kind: 'dir', path: resolve(value) }
    : { kind: 'git', url: value };
}

/** The official Bun installer for the platform, as [command, args]. */
export function bunInstallCommand(platform) {
  return platform === 'win32'
    ? ['powershell', ['-c', 'irm bun.sh/install.ps1|iex']]
    : ['bash', ['-c', 'curl -fsSL https://bun.sh/install | bash']];
}

/** Where the installer puts Bun when it is not on PATH yet. */
export function bunCandidates(home, env, platform) {
  const exe = platform === 'win32' ? 'bun.exe' : 'bun';
  const candidates = [join(home, '.bun', 'bin', exe)];
  if (env.BUN_INSTALL) candidates.unshift(join(env.BUN_INSTALL, 'bin', exe));
  return candidates;
}

function gitHelp(platform) {
  if (platform === 'darwin')
    return ['Install it with: xcode-select --install   (or: brew install git)'];
  if (platform === 'win32')
    return [
      'This template runs inside WSL on Windows: run `wsl --install` in an',
      'Administrator PowerShell, restart, then run this command inside Ubuntu.',
    ];
  return [
    'Install it with your package manager, e.g. sudo apt-get install -y git',
    '(or sudo dnf install -y git), or see https://git-scm.com/downloads',
  ];
}

const wantsYes = (args) => args.includes('--yes') || args.includes('-y');

async function locateBun(deps) {
  if ((await deps.probe('bun', ['--version'])) === 0) return 'bun';
  return (
    bunCandidates(deps.home, deps.env, deps.platform).find((path) =>
      deps.exists(path),
    ) ?? null
  );
}

async function installBun(deps, forwarded) {
  const [command, args] = bunInstallCommand(deps.platform);
  deps.log(
    'Bun is not installed. It is the JavaScript runtime this template uses.',
  );
  deps.log(`The official installer runs: ${command} ${args.join(' ')}`);
  if (forwarded.includes('--dry-run')) {
    deps.log('[dry run] Not installing Bun; install it and run this again.');
    return null;
  }
  const consent =
    wantsYes(forwarded) || (await deps.confirm('Install Bun now?'));
  if (!consent) {
    deps.log('Install Bun from https://bun.sh, then run this again.');
    return null;
  }
  if ((await deps.run(command, args, {})) !== 0) {
    deps.log(
      'Installing Bun failed. Install it from https://bun.sh, then run this again.',
    );
    return null;
  }
  return locateBun(deps);
}

async function fetchTemplate(deps, template) {
  if (template.kind === 'dir') return { root: template.path, temporary: false };
  const root = deps.makeTempDir();
  deps.log(`Downloading the template from ${template.url}…`);
  const code = await deps.run(
    'git',
    ['clone', '--depth', '1', '--quiet', template.url, root],
    {},
  );
  if (code !== 0) {
    deps.remove(root);
    return null;
  }
  return { root, temporary: true };
}

async function runWizard(deps, bun, root, forwarded) {
  const wizard = join(root, 'cli', 'wizard.ts');
  if (!deps.exists(wizard)) {
    deps.log(`The template at ${root} has no cli/wizard.ts.`);
    return 1;
  }
  const path =
    bun === 'bun'
      ? deps.env.PATH
      : `${dirname(bun)}${delimiter}${deps.env.PATH ?? ''}`;
  // Ctrl-C stops the wizard (and the app it runs); this process stays to clean up.
  const release = deps.holdInterrupts();
  try {
    return await deps.run(bun, [wizard, ...forwarded], {
      cwd: deps.cwd,
      env: { ...deps.env, PATH: path },
    });
  } finally {
    release();
  }
}

/** Runs the bootstrapper. Returns a process exit code. */
export async function main(argv, deps) {
  deps.log(BANNER);
  const { template, forwarded } = splitArgs(argv);
  if ((await deps.probe('git', ['--version'])) !== 0) {
    deps.log('Git is not installed. It keeps your project history.');
    gitHelp(deps.platform).forEach((line) => deps.log(line));
    deps.log('Then run this command again.');
    return 1;
  }
  const bun = (await locateBun(deps)) ?? (await installBun(deps, forwarded));
  if (bun === null) return 1;
  const fetched = await fetchTemplate(
    deps,
    resolveTemplate(template, deps.env, deps.isDirectory),
  );
  if (fetched === null) {
    deps.log(
      'Downloading the template failed. Check your internet connection and try again.',
    );
    return 1;
  }
  try {
    return await runWizard(deps, bun, fetched.root, forwarded);
  } finally {
    if (fetched.temporary) deps.remove(fetched.root);
  }
}
