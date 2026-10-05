import { join } from 'node:path';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  bunCandidates,
  bunInstallCommand,
  DEFAULT_TEMPLATE,
  main,
  resolveTemplate,
  splitArgs,
} from './lib/create.js';

setupRitewayBun();

type Call = {
  command: string;
  args: string[];
  env?: Record<string, string> | undefined;
};

const fake = (
  options: {
    missing?: string[];
    exists?: (path: string) => boolean;
    directories?: string[];
    env?: Record<string, string>;
    runCode?: (command: string, args: string[]) => number;
    consent?: boolean;
  } = {},
) => {
  const calls: Call[] = [];
  const removed: string[] = [];
  const logs: string[] = [];
  const deps = {
    platform: 'darwin',
    env: { PATH: '/usr/bin', ...options.env },
    home: '/home/me',
    cwd: '/work',
    log: (line: string) => logs.push(line),
    probe: async (command: string) =>
      (options.missing ?? []).includes(command) ? 127 : 0,
    run: async (
      command: string,
      args: string[],
      run: { env?: Record<string, string> },
    ) => {
      calls.push({ command, args, env: run.env });
      return options.runCode?.(command, args) ?? 0;
    },
    confirm: async () => options.consent ?? true,
    exists: options.exists ?? (() => true),
    isDirectory: (path: string) => (options.directories ?? []).includes(path),
    makeTempDir: () => '/tmp/init-offense-x',
    remove: (path: string) => removed.push(path),
    holdInterrupts: () => () => {},
  };
  return { deps, calls, removed, logs };
};

describe('splitArgs', () => {
  test('template flag', () => {
    assert({
      given: 'a directory, wizard flags and --template in both spellings',
      should: 'take --template out and forward the rest in order',
      actual: [
        splitArgs(['my-app', '--template', '/t', '--yes']),
        splitArgs(['--template=/u', 'my-app', '--no-drive']),
      ],
      expected: [
        { template: '/t', forwarded: ['my-app', '--yes'] },
        { template: '/u', forwarded: ['my-app', '--no-drive'] },
      ],
    });
  });
});

describe('resolveTemplate', () => {
  const isDir = (path: string) => path === '/checkout';
  test('precedence', () => {
    assert({
      given: 'a flag, the env override, and neither',
      should:
        'prefer the flag, then INIT_OFFENSE_TEMPLATE, then the public repo',
      actual: [
        resolveTemplate('/checkout', { INIT_OFFENSE_TEMPLATE: 'x' }, isDir),
        resolveTemplate(
          undefined,
          { INIT_OFFENSE_TEMPLATE: 'git@h:o/r.git' },
          isDir,
        ),
        resolveTemplate(undefined, {}, isDir),
      ],
      expected: [
        { kind: 'dir', path: '/checkout' },
        { kind: 'git', url: 'git@h:o/r.git' },
        { kind: 'git', url: DEFAULT_TEMPLATE },
      ],
    });
  });
});

describe('bun install', () => {
  test('platforms', () => {
    assert({
      given: 'macOS/Linux and Windows',
      should: 'use the official install scripts and look in ~/.bun/bin',
      actual: [
        bunInstallCommand('linux'),
        bunInstallCommand('win32'),
        bunCandidates('/h', { BUN_INSTALL: '/b' }, 'linux'),
      ],
      expected: [
        ['bash', ['-c', 'curl -fsSL https://bun.sh/install | bash']],
        ['powershell', ['-c', 'irm bun.sh/install.ps1|iex']],
        ['/b/bin/bun', '/h/.bun/bin/bun'],
      ],
    });
  });
});

describe('main', () => {
  test('cloned template', async () => {
    const { deps, calls, removed } = fake();
    const code = await main(['my-app', '--yes', '--no-drive'], deps);
    assert({
      given: 'bun and git present and no override',
      should:
        'shallow-clone the template, run the wizard with the args, then clean up',
      actual: [
        code,
        calls.map(({ command, args }) => [command, ...args].join(' ')),
        removed,
      ],
      expected: [
        0,
        [
          `git clone --depth 1 --quiet ${DEFAULT_TEMPLATE} /tmp/init-offense-x`,
          'bun /tmp/init-offense-x/cli/wizard.ts my-app --yes --no-drive',
        ],
        ['/tmp/init-offense-x'],
      ],
    });
  });

  test('local template', async () => {
    const { deps, calls, removed } = fake({
      directories: ['/checkout'],
      env: { INIT_OFFENSE_TEMPLATE: '/checkout' },
      runCode: () => 3,
    });
    const code = await main(['--dry-run'], deps);
    assert({
      given: 'INIT_OFFENSE_TEMPLATE naming a directory and a failing wizard',
      should:
        'run its wizard in place, delete nothing and pass the exit code on',
      actual: [
        code,
        calls.map(({ command, args }) => [command, ...args].join(' ')),
        removed,
      ],
      expected: [3, ['bun /checkout/cli/wizard.ts --dry-run'], []],
    });
  });

  test('missing bun', async () => {
    const installed = new Set<string>();
    const { deps, calls } = fake({
      missing: ['bun'],
      exists: (path) => installed.has(path) || path.endsWith('wizard.ts'),
      runCode: (command) => {
        if (command === 'bash')
          installed.add(join('/home/me', '.bun', 'bin', 'bun'));
        return 0;
      },
    });
    const code = await main(['my-app'], deps);
    const wizard = calls.at(-1);
    assert({
      given: 'no bun and consent to install it',
      should:
        'run the official installer, then the wizard with ~/.bun/bin first on PATH',
      actual: [code, calls[0]?.command, wizard?.command, wizard?.env?.PATH],
      expected: [
        0,
        'bash',
        '/home/me/.bun/bin/bun',
        '/home/me/.bun/bin:/usr/bin',
      ],
    });
  });

  test('declined bun install', async () => {
    const { deps, calls } = fake({
      missing: ['bun'],
      exists: () => false,
      consent: false,
    });
    assert({
      given: 'no bun and the install declined',
      should: 'exit 1 without running anything',
      actual: [await main([], deps), calls],
      expected: [1, []],
    });
  });

  test('missing git', async () => {
    const { deps, calls, logs } = fake({ missing: ['git'] });
    assert({
      given: 'no git',
      should: 'explain how to install it and exit 1',
      actual: [
        await main([], deps),
        calls,
        logs.some((line) => line.includes('xcode-select --install')),
      ],
      expected: [1, [], true],
    });
  });

  test('failed clone', async () => {
    const { deps, removed } = fake({
      runCode: (command) => (command === 'git' ? 128 : 0),
    });
    assert({
      given: 'the clone failing',
      should: 'exit 1 and remove the temporary directory',
      actual: [await main([], deps), removed],
      expected: [1, ['/tmp/init-offense-x']],
    });
  });
});
