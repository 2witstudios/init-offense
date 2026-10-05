/**
 * Step 5 of the wizard: give the new project free local ports, start its
 * database and app, open the browser, and print what was created.
 */
import { join } from 'node:path';
import type { Accounts } from './wizard-accounts';
import type { Created } from './wizard-create';
import { act, display, WizardStop, type WizardDeps } from './wizard-deps';
import {
  DEFAULT_PORTS,
  pickPorts,
  setEnv,
  stackEnv,
  type Ports,
} from './wizard-env';
import { privateOnFreeNote } from './wizard-plan';
import type { Flags } from './wizard-questions';

const READY_TIMEOUT_MS = 180_000;
const READY_POLL_MS = 1_000;

/** The drive's dashboard URL from the generated project.config.json. */
export function driveUrl(configText: string | null): string | null {
  if (configText === null) return null;
  try {
    const config = JSON.parse(configText) as {
      pagespace?: { apiUrl?: unknown; driveId?: unknown };
    };
    const { apiUrl, driveId } = config.pagespace ?? {};
    return typeof apiUrl === 'string' && typeof driveId === 'string'
      ? `${apiUrl}/dashboard/${driveId}`
      : null;
  } catch {
    return null;
  }
}

const OPTIONAL_STEPS = [
  'Real email: add RESEND_API_KEY and AUTH_EMAIL_FROM to .env (until then sign-in links print in the terminal).',
  'Agents: create a GitHub machine user for autonomous agents and fill .env.agent from .env.agent.example.',
  'Reviews: create the review-record GitHub App (docs/development/review-record.md).',
  'Deploy: create the Fly apps (docs/operations/deploy-staging.md).',
];

function summary(
  accounts: Accounts,
  created: Created,
  drive: string | null,
  dryRun = false,
): string[] {
  const repo = `https://github.com/${accounts.owner}/${accounts.slug}`;
  return [
    dryRun ? '\nWould create:' : '\nCreated:',
    `  • ${accounts.display} in ${accounts.target}`,
    ...(accounts.github
      ? [
          `  • ${accounts.visibility === 'public' ? 'Public' : 'Private'} GitHub repository ${repo}${created.pushed ? '' : ' (not pushed yet)'}`,
        ]
      : []),
    ...(created.drive
      ? [`  • PageSpace drive ${drive ?? '(see project.config.json)'}`]
      : []),
    ...(accounts.github
      ? privateOnFreeNote(
          `${accounts.owner}/${accounts.slug}`,
          accounts.visibility,
          accounts.plan,
        )
      : []),
    '\nOptional next steps, whenever you are ready:',
    ...OPTIONAL_STEPS.map((line, index) => `  ${index + 1}. ${line}`),
  ];
}

function signInBox(appUrl: string, target: string): string[] {
  const lines = [
    'How to sign in:',
    `  1. On ${appUrl}/sign-in, enter any email address and request a link.`,
    '  2. No email is sent on your computer: the sign-in link appears in THIS',
    '     terminal, in a block of lines starting with [dev-mail]. Open its',
    '     "Link:" in your browser to sign in.',
    '',
    'Ctrl-C stops the app. To start it again later:',
    `  cd ${target} && bun slot:up && bun dev`,
  ];
  const rule = '─'.repeat(72);
  return [rule, ...lines.map((line) => `│ ${line}`), rule];
}

function writeEnv(
  deps: WizardDeps,
  flags: Flags,
  path: string,
  values: Record<string, string>,
): void {
  const entries = Object.entries(values);
  if (entries.length === 0) return;
  deps.log(
    `  ${flags.dryRun ? '[dry run] ' : ''}write .env: ${entries.map(([key, value]) => `${key}=${value}`).join(' ')}`,
  );
  if (flags.dryRun) {
    if (entries.some(([key]) => key.endsWith('_POSTGRES_PORT')))
      deps.log(
        '  [dry run] (plus every Postgres and Redis URL in .env, moved to these ports)',
      );
    return;
  }
  const text = deps.readFile(path);
  if (text === null)
    throw new WizardStop(
      `${path} is missing; copy .env.example to .env and run bun slot:up.`,
    );
  deps.writeFile(path, setEnv(text, values));
}

function choosePorts(deps: WizardDeps): Ports {
  const ports = pickPorts(deps.isPortFree);
  if (ports === null)
    throw new WizardStop(
      'Could not find free local ports for the database and app.',
    );
  const moved = (Object.keys(DEFAULT_PORTS) as (keyof Ports)[]).filter(
    (key) => ports[key] !== DEFAULT_PORTS[key],
  );
  deps.log(
    `  ports: Postgres ${ports.postgres}, Redis ${ports.redis}, app ${ports.app}` +
      (moved.length > 0
        ? ` (moved ${moved.join(', ')}: the default was taken)`
        : ''),
  );
  return ports;
}

async function openWhenReady(
  deps: WizardDeps,
  url: string,
  urls: readonly string[],
  exited: () => boolean,
) {
  for (
    let waited = 0;
    waited < READY_TIMEOUT_MS && !exited();
    waited += READY_POLL_MS
  ) {
    if (await deps.reachable(url)) {
      urls.forEach((target) => deps.open(target));
      return;
    }
    await deps.sleep(READY_POLL_MS);
  }
}

/** Ports, database, summary, then the dev server in the foreground. */
export async function runLocally(
  deps: WizardDeps,
  flags: Flags,
  accounts: Accounts,
  created: Created,
): Promise<void> {
  const drive = driveUrl(
    deps.readFile(join(accounts.target, 'project.config.json')),
  );
  if (!accounts.run) {
    summary(accounts, created, drive, flags.dryRun).forEach((line) =>
      deps.log(line),
    );
    if (drive && !flags.dryRun) deps.open(drive);
    deps.log(
      `\nStart the app any time: cd ${accounts.target} && bun slot:up && bun dev`,
    );
    return;
  }
  deps.log('\n— Step 5 of 5: run it —');
  const envPath = join(accounts.target, '.env');
  const ports = choosePorts(deps);
  writeEnv(
    deps,
    flags,
    envPath,
    stackEnv(deps.readFile(envPath) ?? '', accounts.slug, ports),
  );
  if (
    act(deps, flags.dryRun, ['bun', 'slot:up'], { cwd: accounts.target }) !== 0
  )
    throw new WizardStop(
      `Starting the database failed. Check Docker is running, then run: cd ${accounts.target} && bun slot:up`,
    );
  summary(accounts, created, drive, flags.dryRun).forEach((line) =>
    deps.log(line),
  );
  const appUrl = `http://localhost:${ports.app}`;
  deps.log('');
  signInBox(appUrl, accounts.target).forEach((line) => deps.log(line));
  const dev = ['bun', 'dev'];
  deps.log(
    `\nStarting the app; your browser opens ${appUrl}/sign-in${drive ? ' and your drive' : ''} once it is ready.`,
  );
  if (flags.dryRun) {
    deps.log(`  [dry run] ${display(dev, { cwd: accounts.target })}`);
    return;
  }
  deps.log(`  ${display(dev, { cwd: accounts.target })}`);
  const release = deps.holdInterrupts();
  let done = false;
  const exited = deps.runner
    .start(dev, { cwd: accounts.target })
    .finally(() => {
      done = true;
    });
  await openWhenReady(
    deps,
    `${appUrl}/sign-in`,
    [`${appUrl}/sign-in`, ...(drive ? [drive] : [])],
    () => done,
  );
  await exited;
  release();
  deps.log(
    `\nThe app stopped. Start it again any time: cd ${accounts.target} && bun slot:up && bun dev`,
  );
}
