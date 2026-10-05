import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { main, type Deps } from './init';

setupRitewayBun();

const scratch = mkdtempSync(join(tmpdir(), 'init-offense-cli-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const fakeDeps = (answer: boolean) => {
  const commands: string[] = [];
  const logs: string[] = [];
  const deps: Deps = {
    run: (command, args) => {
      commands.push([command, ...args].join(' '));
      return 0;
    },
    ghLogin: () => null,
    confirm: () => answer,
    log: (line) => logs.push(line),
  };
  return { deps, commands, logs };
};

describe('main', () => {
  test('--yes runs install, commit and GitHub creation in order', () => {
    const { deps, commands } = fakeDeps(false);
    const code = main(
      [
        'new',
        join(scratch, 'full'),
        '--name',
        'widget-app',
        '--owner',
        'someone',
        '--yes',
      ],
      deps,
    );
    assert({
      given: 'every step enabled and --yes',
      should: 'run the commands in order without asking',
      actual: { code, commands },
      expected: {
        code: 0,
        commands: [
          'git init -q -b main',
          'bun install',
          'bun auth:provision',
          'bunx --bun prettier --write .',
          'bunx --bun prettier --check .',
          'bunx --bun jscpd --update-baseline',
          'bunx --bun jscpd --config .jscpd-tests.json --update-baseline',
          'bunx --bun prettier --write .jscpd-baseline.json .jscpd-tests-baseline.json',
          'git add -A',
          'git commit -q -m chore: initialize widget-app from init-offense',
          `gh repo create someone/widget-app --private --source ${join(scratch, 'full')} --remote origin`,
          'bun scripts/drive-bootstrap.ts',
        ],
      },
    });
  });

  test('a declined confirmation skips GitHub creation', () => {
    const { deps, commands, logs } = fakeDeps(false);
    main(
      [
        'new',
        join(scratch, 'declined'),
        '--name',
        'widget-app',
        '--no-install',
        '--no-drive',
      ],
      deps,
    );
    assert({
      given: 'GitHub creation enabled and declined',
      should: 'run nothing and say it skipped',
      actual: [commands, logs.includes('Skipped GitHub repository creation.')],
      expected: [[], true],
    });
  });

  test('a failing command stops the flow', () => {
    const { deps, logs } = fakeDeps(true);
    const failing: Deps = { ...deps, run: () => 1 };
    assert({
      given: 'the first command failing',
      should: 'exit 1',
      actual: main(
        [
          'new',
          join(scratch, 'failing'),
          '--name',
          'widget-app',
          '--no-github',
          '--no-drive',
        ],
        failing,
      ),
      expected: 1,
    });
    assert({
      given: 'the first command failing',
      should: 'name the failed step',
      actual: logs.some((line) =>
        line.includes('failed (exit 1): init repository'),
      ),
      expected: true,
    });
  });

  describe('formatting the renamed tree', () => {
    // Prettier can need a second pass after a rename; the CLI rewrites until
    // `--check` passes, at most three times.
    const formatRun = (unsettledChecks: number) => {
      const { deps, commands, logs } = fakeDeps(true);
      let checks = 0;
      const run: Deps['run'] = (command, args, cwd) => {
        deps.run(command, args, cwd);
        if (args.includes('--check')) {
          checks += 1;
          return checks <= unsettledChecks ? 1 : 0;
        }
        return 0;
      };
      const code = main(
        [
          'new',
          join(scratch, `format-${unsettledChecks}`),
          '--name',
          'widget-app',
          '--no-github',
          '--no-drive',
        ],
        { ...deps, run },
      );
      const prettier = commands.filter((line) => line.includes('prettier'));
      return { code, prettier, logs };
    };
    const pass = [
      'bunx --bun prettier --write .',
      'bunx --bun prettier --check .',
    ];
    const baselines =
      'bunx --bun prettier --write .jscpd-baseline.json .jscpd-tests-baseline.json';

    test('rewrites again while the check still finds changes', () => {
      assert({
        given: 'a tree that settles on the second prettier pass',
        should: 'write twice, check twice and continue',
        actual: (({ code, prettier }) => ({ code, prettier }))(formatRun(1)),
        expected: { code: 0, prettier: [...pass, ...pass, baselines] },
      });
    });

    test('gives up after three unsettled passes', () => {
      const { code, prettier, logs } = formatRun(3);
      assert({
        given: 'a tree prettier never settles',
        should: 'stop after three passes, name the problem and exit 1',
        actual: {
          code,
          prettier,
          named: logs.some((line) =>
            line.includes('formatting did not settle after 3 prettier passes'),
          ),
        },
        expected: {
          code: 1,
          prettier: [...pass, ...pass, ...pass],
          named: true,
        },
      });
    });
  });

  test('refusals', () => {
    const { deps } = fakeDeps(true);
    const target = join(scratch, 'refusals');
    const offline = ['--no-install', '--no-github', '--no-drive'];
    main(['new', target, '--name', 'widget-app', ...offline], deps);
    assert({
      given: 'a non-empty target, an unknown module and a bad slug',
      should: 'exit 2 for each',
      actual: [
        main(['new', target, '--name', 'widget-app', ...offline], deps),
        main(
          [
            'new',
            join(scratch, 'u'),
            '--name',
            'w',
            '--without',
            'nope',
            ...offline,
          ],
          deps,
        ),
        main(['new', join(scratch, 'b'), '--name', 'Bad'], deps),
      ],
      expected: [2, 2, 2],
    });
  });
});
