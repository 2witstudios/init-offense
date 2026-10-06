import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { partitionAffected, planGates } from './check-affected';

setupRitewayBun();

const root = new URL('..', import.meta.url).pathname;
const { scripts } = (await Bun.file(`${root}package.json`).json()) as {
  scripts: Record<string, string>;
};

const lintTimeout = (script: string | undefined): number =>
  Number(
    /bun test --timeout (\d+) eslint\.config\.test\.ts/.exec(
      script ?? '',
    )?.[1] ?? 0,
  );

describe('package scripts', () => {
  test('runs the ESLint configuration test with a load-tolerant timeout', () => {
    assert({
      given:
        'the lint and test:lint scripts, and the check:affected gate the pre-push hook runs',
      should:
        'give eslint.config.test.ts at least two minutes, not the fixed 5 s default',
      actual: [
        lintTimeout(scripts.lint),
        lintTimeout(scripts['test:lint']),
        lintTimeout(
          planGates(partitionAffected(['eslint.config.mjs']), 'base')
            .find(({ name }) => name === 'eslint config tests')
            ?.args.join(' '),
        ),
      ].map((ms) => ms >= 120_000),
      expected: [true, true, true],
    });
  });

  test('starts knip where its config loader finds the root tsconfig.json', async () => {
    // knip creates its jiti loader with the working directory as if it were
    // a file, so jiti's tsconfig search starts at dirname(cwd) and walks up.
    // Run from the repository root, that skips this repository entirely and
    // crashes on any unrelated parent tsconfig.json with a broken `extends`.
    // Starting one level down makes the search begin here and stop at the
    // root tsconfig.json, which compiles nothing.
    const cwd = /^cd (\S+) && bunx --bun knip --directory (\S+)$/.exec(
      scripts.knip ?? '',
    );
    const searchStart = cwd ? dirname(join(root, cwd[1] ?? '')) : '';
    const tsconfig = join(searchStart, 'tsconfig.json');
    assert({
      given: 'the knip script and the root tsconfig.json',
      should:
        'run knip from a subdirectory against the root, so the search starts at a root tsconfig.json that includes no files',
      actual: {
        directory: cwd ? join(root, cwd[1] ?? '', cwd[2] ?? '') : null,
        searchStart,
        tsconfig: existsSync(tsconfig)
          ? ((await Bun.file(tsconfig).json()) as unknown)
          : null,
      },
      expected: {
        directory: join(root, '.'),
        searchStart: join(root, '.'),
        tsconfig: { files: [] },
      },
    });
  });
});
