import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { wizard } from './wizard';
import { hasPersonalLogin } from './wizard-accounts';
import { checkPrerequisites } from './wizard-prereqs';
import { driveUrl, runLocally } from './wizard-run';
import { fakeDeps } from './wizard.test-support';

setupRitewayBun();

const scratch = mkdtempSync(join(tmpdir(), 'init-offense-wizard-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('wizard flags', () => {
  test('--yes without a name', async () => {
    const fake = fakeDeps();
    assert({
      given: '--yes with no --name and no directory',
      should: 'refuse with exit 2 before doing anything',
      actual: [
        await wizard(['--yes'], fake.deps),
        fake.logs[0]?.split('\n')[0],
        fake.ran,
      ],
      expected: [
        2,
        'Error: --yes needs --name <slug> or a directory to name the app after',
        [],
      ],
    });
  });

  test('bad slug', async () => {
    const fake = fakeDeps();
    assert({
      given: 'a slug containing the placeholder',
      should: 'name the flag and the rule',
      actual: [
        await wizard(['--name', 'acme-x'], fake.deps),
        fake.logs[0]?.split('\n')[0],
      ],
      expected: [
        2,
        'Error: --name must not contain the template placeholder "acme"',
      ],
    });
  });
});

describe('dry run', () => {
  test('minimal', async () => {
    const fake = fakeDeps();
    const target = join(scratch, 'wiz-test');
    const code = await wizard(
      [
        '--dry-run',
        '--yes',
        '--no-github',
        '--no-drive',
        '--no-run',
        '--name',
        'wiz-test',
        '--dir',
        target,
      ],
      fake.deps,
    );
    assert({
      given: '--dry-run with every optional step off',
      should: 'exit 0, run nothing, open nothing and say so',
      actual: [code, fake.ran, fake.opened, fake.logs.at(-1)],
      expected: [
        0,
        [],
        [],
        '\nDry run finished: nothing was installed, created or changed.',
      ],
    });
  });

  test('everything on', async () => {
    const fake = fakeDeps({
      probes: { 'gh api user --jq .login': { code: 0, stdout: 'octo\n' } },
    });
    const code = await wizard(
      [
        '--dry-run',
        '--yes',
        '--name',
        'widget',
        '--dir',
        join(scratch, 'widget'),
      ],
      fake.deps,
    );
    const shown = fake.logs
      .filter((line) => line.includes('[dry run]'))
      .map((line) => line.trim());
    assert({
      given: '--dry-run with GitHub, drive and run on',
      should: 'show every external action and execute none',
      actual: [code, fake.ran],
      expected: [0, []],
    });
    assert({
      given: 'the dry-run transcript',
      should:
        'show the repo, the masked bootstrap token, the key revoke, the push, slot:up and dev',
      actual: [
        shown.some((line) =>
          line.includes('gh repo create octo/widget --private'),
        ),
        shown.some((line) =>
          line.includes(
            'PAGESPACE_BOOTSTRAP_TOKEN=*** bun scripts/drive-bootstrap.ts --github',
          ),
        ),
        shown.some((line) => line.includes('pagespace keys revoke')),
        shown.some((line) => line.includes('git push -u origin main')),
        shown.some((line) => line.includes('$ bun slot:up')),
        shown.some((line) => line.includes('$ bun dev')),
      ],
      expected: [true, true, true, true, true, true],
    });
    assert({
      given: 'the plan shown before anything is created',
      should: 'say upfront that two keys are approved in the browser and which',
      actual: fake.logs.some((line) =>
        line.includes(
          "you approve two keys in your browser: a temporary setup key (removed afterwards), then the drive's own key for this project",
        ),
      ),
      expected: true,
    });
  });
});

describe('runLocally', () => {
  test('ports, .env, slot:up, dev and browser', async () => {
    const target = '/work/widget';
    const fake = fakeDeps({
      isPortFree: (port) => port !== 15432 && port !== 3000,
      files: {
        [`${target}/.env`]:
          'KEEP=yes\nDATABASE_URL=postgres://widget:pw@localhost:15432/widget\nREDIS_URL=redis://localhost:6379\nPORT=3000\n',
        [`${target}/project.config.json`]: JSON.stringify({
          pagespace: { apiUrl: 'https://pagespace.ai', driveId: 'drive1' },
        }),
      },
    });
    const accounts = {
      display: 'Widget',
      slug: 'widget',
      target,
      github: false,
      visibility: 'private' as const,
      plan: null,
      drive: true,
      run: true,
      owner: 'octo',
    };
    await runLocally(fake.deps, { yes: true, dryRun: false }, accounts, {
      drive: true,
      pushed: false,
      reviewGate: false,
    });
    assert({
      given: 'Postgres and app default ports taken',
      should:
        'write the moved stack and app port variables before slot:up (which derives PORT from them), keeping other keys',
      actual: fake.files[`${target}/.env`],
      expected:
        'KEEP=yes\nDATABASE_URL=postgres://widget:pw@localhost:15433/widget\nREDIS_URL=redis://localhost:6379\nPORT=3000\n' +
        'WIDGET_POSTGRES_PORT=15433\nWIDGET_REDIS_PORT=6379\nWIDGET_APP_PORT=3001\n',
    });
    assert({
      given: 'a reachable dev server and a provisioned drive',
      should: 'run slot:up then dev, and open the sign-in page and the drive',
      actual: [fake.ran, fake.opened],
      expected: [
        ['bun slot:up', 'bun dev'],
        [
          'http://localhost:3001/sign-in',
          'https://pagespace.ai/dashboard/drive1',
        ],
      ],
    });
  });
});

describe('account and drive helpers', () => {
  test('hasPersonalLogin', () => {
    assert({
      given:
        'whoami JSON with and without a personal login, a failure and garbage',
      should: 'only accept personalLogin: true from a successful run',
      actual: [
        hasPersonalLogin(0, '{"personalLogin":true}'),
        hasPersonalLogin(0, '{"personalLogin":false}'),
        hasPersonalLogin(1, '{"personalLogin":true}'),
        hasPersonalLogin(0, 'Not logged in'),
      ],
      expected: [true, false, false, false],
    });
  });

  test('driveUrl', () => {
    assert({
      given: 'a provisioned config, an unprovisioned one and no file',
      should: 'link the drive dashboard only when the drive exists',
      actual: [
        driveUrl(
          '{"pagespace":{"apiUrl":"https://pagespace.ai","driveId":"d1"}}',
        ),
        driveUrl(
          '{"pagespace":{"apiUrl":"https://pagespace.ai","driveId":null}}',
        ),
        driveUrl(null),
      ],
      expected: ['https://pagespace.ai/dashboard/d1', null, null],
    });
  });
});

describe('checkPrerequisites', () => {
  const answers = {
    display: 'Widget',
    slug: 'widget',
    target: '/work/widget',
    github: true,
    visibility: 'private' as const,
    plan: null,
    drive: false,
    run: false,
  };

  test('missing gh with brew', async () => {
    let installed = false;
    const fake = fakeDeps({
      run: (command) => {
        if (command === 'brew install gh') installed = true;
        return 0;
      },
      prompt: { confirm: async () => true },
    });
    const probe = fake.deps.runner.probe;
    const deps = {
      ...fake.deps,
      runner: {
        ...fake.deps.runner,
        probe: (command: readonly string[]) =>
          command[0] === 'gh' && !installed
            ? { code: 127, stdout: '' }
            : probe(command),
      },
    };
    await checkPrerequisites(deps, { yes: false, dryRun: false }, answers);
    assert({
      given: 'gh missing on macOS with Homebrew and consent',
      should: 'show and run brew install gh, then re-check',
      actual: [fake.ran, fake.logs.includes('  $ brew install gh')],
      expected: [['brew install gh'], true],
    });
  });

  test('declined install', async () => {
    const fake = fakeDeps({
      probes: { 'gh --version': { code: 127, stdout: '' } },
      prompt: { confirm: async () => false },
    });
    const outcome = await checkPrerequisites(
      fake.deps,
      { yes: false, dryRun: false },
      answers,
    ).catch((error: Error) => error.message);
    assert({
      given: 'a declined install',
      should: 'stop with the reason and run nothing',
      actual: [outcome, fake.ran],
      expected: [
        'GitHub CLI (gh) is needed. Install it with the commands above, then run this again.',
        [],
      ],
    });
  });
});
