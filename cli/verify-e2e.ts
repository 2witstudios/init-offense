/**
 * The acceptance loop's optional `e2e` stage: the generated project's
 * browser suite against a stack of its own.
 *
 * It picks free host ports away from the defaults (another project's stack
 * may hold 15432/6379 or the next few), writes them to the generated
 * `.env` as `<SCREAMING_SLUG>_POSTGRES_PORT` / `_REDIS_PORT` / `_APP_PORT`
 * with every stack URL, starts the stack under its own Compose project
 * (`verify-<slug>`) through `bun slot:up`, runs the suite in Chromium and
 * Firefox, and always removes that Compose project and its volume. No other
 * container is ever touched.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pickPorts, setEnv, stackEnv, type Ports } from './wizard-env';

/** Probing starts here, clear of the defaults a developer's stacks hold. */
const VERIFY_PORTS: Ports = { postgres: 25432, redis: 16379, app: 3200 };

/** WebKit is left out: on macOS it follows the system Tab-focus setting. */
const E2E_PROJECTS = ['chromium', 'firefox'] as const;

/** `bun test:e2e` runs turbo, so Playwright's arguments follow a second `--`. */
const E2E_TEST_ARGS = [
  'run',
  'test:e2e',
  '--',
  '--',
  ...E2E_PROJECTS.map((project) => `--project=${project}`),
];

export const composeProject = (slug: string): string => `verify-${slug}`;

const DOWN_ARGS = [
  'compose',
  '--file',
  'infra/compose.yaml',
  'down',
  '--volumes',
  '--remove-orphans',
];

const envKeys = (dotenv: string): string[] =>
  Array.from(
    dotenv.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=/gm),
    (m) => m[1] ?? '',
  );

/**
 * The environment for every e2e step: the inherited one without any key the
 * generated `.env` sets (Bun loads the caller's own `.env` into
 * `process.env`, and an inherited value would win over the project's), and
 * without a Compose file, plus the stage's own Compose project.
 */
export function e2eEnv(
  parent: Readonly<Record<string, string | undefined>>,
  dotenv: string,
  slug: string,
): Record<string, string> {
  const owned = new Set([...envKeys(dotenv), 'COMPOSE_FILE']);
  return {
    ...Object.fromEntries(
      Object.entries(parent).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && !owned.has(entry[0]),
      ),
    ),
    COMPOSE_PROJECT_NAME: composeProject(slug),
  };
}

export type Run = (
  command: string,
  args: readonly string[],
  cwd: string,
  log: string,
  env: Record<string, string>,
) => number;

export type E2EStage = {
  readonly dir: string;
  readonly slug: string;
  readonly logs: string;
  readonly isPortFree: (port: number) => boolean;
  readonly run: Run;
  readonly say: (line: string) => void;
};

/** Runs the stage; returns its exit status (0 when the suite passed). */
export function runE2EStage(stage: E2EStage): number {
  const ports = pickPorts(stage.isPortFree, VERIFY_PORTS);
  if (ports === null) {
    stage.say('  e2e: no free ports for the stack');
    return 1;
  }
  const envPath = join(stage.dir, '.env');
  const before = readFileSync(envPath, 'utf8');
  const dotenv = setEnv(before, stackEnv(before, stage.slug, ports));
  writeFileSync(envPath, dotenv);
  const env = e2eEnv(process.env, dotenv, stage.slug);
  const log = (name: string) => join(stage.logs, `${name}.log`);
  stage.say(
    `  e2e: stack ${composeProject(stage.slug)} on Postgres ${ports.postgres}, Redis ${ports.redis}, app ${ports.app}`,
  );
  // A previous run that was killed may have left this project's stack up.
  stage.run('docker', DOWN_ARGS, stage.dir, log('e2e-down-before'), env);
  try {
    if (stage.run('bun', ['slot:up'], stage.dir, log('e2e-up'), env) !== 0)
      return 1;
    return stage.run('bun', E2E_TEST_ARGS, stage.dir, log('e2e'), env);
  } finally {
    if (stage.run('docker', DOWN_ARGS, stage.dir, log('e2e-down'), env) !== 0)
      stage.say(`  e2e: tearing the stack down failed (e2e-down.log)`);
  }
}
