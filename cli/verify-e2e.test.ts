import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { composeProject, e2eEnv, runE2EStage, type Run } from './verify-e2e';

setupRitewayBun();

describe('e2eEnv', () => {
  test('drops what the generated .env owns', () => {
    assert({
      given: "an inherited env carrying the caller's own stack settings",
      should:
        'drop every key the .env sets and COMPOSE_FILE, and name the Compose project',
      actual: e2eEnv(
        {
          PATH: '/bin',
          DATABASE_URL: 'postgres://elsewhere',
          E2E_PORT: '3100',
          COMPOSE_FILE: 'other.yaml',
          UNSET: undefined,
        },
        '# DATABASE_URL=commented\nDATABASE_URL=postgres://x\nE2E_PORT=3300\n',
        'widget-app',
      ),
      expected: { PATH: '/bin', COMPOSE_PROJECT_NAME: 'verify-widget-app' },
    });
  });
});

type Call = {
  readonly command: string;
  readonly args: readonly string[];
  readonly project: string | undefined;
};

const stageIn = (exits: Readonly<Record<string, number>>) => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-e2e-'));
  writeFileSync(
    join(dir, '.env'),
    'DATABASE_URL=postgres://widget_app:pw@localhost:15432/widget_app\nREDIS_URL=redis://localhost:6379\n',
  );
  const calls: Call[] = [];
  const run: Run = (command, args, _cwd, log, env) => {
    calls.push({ command, args, project: env.COMPOSE_PROJECT_NAME });
    return exits[log.slice(log.lastIndexOf('/') + 1)] ?? 0;
  };
  const status = runE2EStage({
    dir,
    slug: 'widget-app',
    logs: dir,
    isPortFree: (port) => port !== 25432,
    run,
    say: () => {},
  });
  return {
    status,
    steps: calls.map(({ command, args }) => [command, args[0], args[1]]),
    projects: [...new Set(calls.map(({ project }) => project))],
    dotenv: readFileSync(join(dir, '.env'), 'utf8'),
  };
};

const DOWN = ['docker', 'compose', '--file'];

describe('runE2EStage', () => {
  test('a passing suite', () => {
    const { status, steps, dotenv, projects } = stageIn({});
    assert({
      given: 'any step',
      should: "run it under the stage's own Compose project",
      actual: projects,
      expected: [composeProject('widget-app')],
    });
    assert({
      given: 'every step succeeding and 25432 taken',
      should:
        'clear leftovers, bring the stack up, run the suite, tear it down and pass',
      actual: { status, steps },
      expected: {
        status: 0,
        steps: [
          DOWN,
          ['bun', 'slot:up', undefined],
          ['bun', 'run', 'test:e2e'],
          DOWN,
        ],
      },
    });
    assert({
      given: 'the picked ports',
      should: 'write them and the moved URLs to the project .env',
      actual: dotenv,
      expected:
        'DATABASE_URL=postgres://widget_app:pw@localhost:25433/widget_app\nREDIS_URL=redis://localhost:16379\nWIDGET_APP_POSTGRES_PORT=25433\nWIDGET_APP_REDIS_PORT=16379\nWIDGET_APP_APP_PORT=3200\n',
    });
  });

  test('a failing stack', () => {
    const { status, steps } = stageIn({ 'e2e-up.log': 1 });
    assert({
      given: 'slot:up failing',
      should: 'skip the suite, still tear the stack down and fail',
      actual: { status, steps },
      expected: {
        status: 1,
        steps: [DOWN, ['bun', 'slot:up', undefined], DOWN],
      },
    });
  });
});
