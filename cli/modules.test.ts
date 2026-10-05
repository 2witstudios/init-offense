import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { isExcluded } from './copy';
import {
  findReferences,
  loadModules,
  matchesPattern,
  partitionFiles,
  prunePackageJson,
  unknownModules,
} from './modules';

setupRitewayBun();

describe('copy exclusions', () => {
  test('keeps source and drops local state', () => {
    const paths = [
      'apps/web/src/app/page.tsx',
      'cli/init.ts',
      'create/bin/init-offense.js',
      'node_modules/x/index.js',
      'apps/web/node_modules/y.js',
      'apps/web/.next/server.js',
      '.turbo/cache',
      '.env',
      'apps/web/.env.local',
      '.env.agent',
      '.env.example',
      '.env.agent.example',
      '.pu/config.yaml',
      '.pu/agent-context.md',
      '.pu/state.json',
      '.claude/worktrees/agent-1/README.md',
      '.claude/skills/x/SKILL.md',
      'packages/db/tsconfig.tsbuildinfo',
      'verify-logs/lint.log',
    ];
    assert({
      given: 'template-relative paths',
      should:
        'exclude cli/, create/, dependencies, build output, secrets and pu runtime state',
      actual: paths.filter((path) => !isExcluded(path)),
      expected: [
        'apps/web/src/app/page.tsx',
        '.env.example',
        '.env.agent.example',
        '.pu/config.yaml',
        '.pu/agent-context.md',
        '.claude/skills/x/SKILL.md',
      ],
    });
  });
});

describe('modules.json', () => {
  const modules = loadModules();

  test('declares realtime and docs as experimental', () => {
    assert({
      given: 'the shipped module list',
      should: 'mark both modules experimental',
      actual: Object.entries(modules).map(([name, spec]) => [
        name,
        spec.experimental,
      ]),
      expected: [
        ['realtime', true],
        ['docs', true],
      ],
    });
  });

  test('unknown module names', () => {
    assert({
      given: 'a typo in --without',
      should: 'report the unknown name',
      actual: unknownModules(modules, ['realtime', 'realtyme']),
      expected: ['realtyme'],
    });
  });

  test('pattern matching', () => {
    assert({
      given: 'directory prefixes and globs',
      should: 'match files under the directory and glob matches only',
      actual: [
        matchesPattern('apps/realtime', 'apps/realtime/src/index.ts'),
        matchesPattern('apps/realtime', 'apps/realtime-x/a.ts'),
        matchesPattern(
          'packages/redis/src/ticket*.ts',
          'packages/redis/src/ticket.test.ts',
        ),
        matchesPattern('scripts/docs-*.ts', 'scripts/pagespace-docs.ts'),
      ],
      expected: [true, false, true, false],
    });
  });

  test('partitions the file list', () => {
    assert({
      given: '--without docs',
      should: 'remove only docs module files',
      actual: partitionFiles(
        [
          'scripts/docs-verify.ts',
          'scripts/dispatch-docs.ts',
          'scripts/board.ts',
        ],
        modules,
        ['docs'],
      ),
      expected: {
        kept: ['scripts/board.ts'],
        removed: ['scripts/docs-verify.ts', 'scripts/dispatch-docs.ts'],
      },
    });
  });
});

describe('prunePackageJson', () => {
  test('drops scripts that run removed files', () => {
    const content = JSON.stringify({
      name: 'root',
      scripts: {
        'docs:verify': 'bun scripts/docs-verify.ts',
        'docs:location': 'bun scripts/pagespace-docs.ts',
        dev: 'turbo run dev',
      },
    });
    const result = prunePackageJson('package.json', content, [
      'scripts/docs-verify.ts',
    ]);
    assert({
      given: 'a root script running a removed file',
      should: 'drop only that script',
      actual: [result.dropped, Object.keys(JSON.parse(result.content).scripts)],
      expected: [
        ['package.json: scripts.docs:verify'],
        ['docs:location', 'dev'],
      ],
    });
  });

  test('applies explicit edits', () => {
    const content = JSON.stringify({
      scripts: { a: 'x' },
      dependencies: { '@w/realtime': '1', b: '1' },
    });
    const result = prunePackageJson(
      'apps/web/package.json',
      content,
      [],
      [
        {
          file: 'apps/web/package.json',
          removeScripts: ['a'],
          removeDependencies: ['@w/realtime'],
        },
      ],
    );
    assert({
      given: 'explicit script and dependency removals',
      should: 'drop them',
      actual: JSON.parse(result.content),
      expected: { scripts: {}, dependencies: { b: '1' } },
    });
  });

  test('leaves untouched files byte-identical', () => {
    const content = '{ "name": "x" }';
    assert({
      given: 'nothing to drop',
      should: 'return the original content',
      actual: prunePackageJson('package.json', content, ['a.ts']).content,
      expected: content,
    });
  });
});

describe('findReferences', () => {
  test('reports imports and mentions of removed files and packages', () => {
    const root = mkdtempSync(join(tmpdir(), 'init-refs-'));
    const write = (path: string, content: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    };
    write(
      'packages/redis/src/index.ts',
      "export * from './ticket';\nexport * from './keys';\n",
    );
    write('apps/web/src/a.ts', "import { x } from '@w/realtime/client';\n");
    write('knip.jsonc', '{ "apps/realtime": {} }\n');
    write('README.md', 'nothing here\n');
    try {
      const refs = findReferences({
        root,
        files: [
          'packages/redis/src/index.ts',
          'apps/web/src/a.ts',
          'knip.jsonc',
          'README.md',
        ],
        removed: ['packages/redis/src/ticket.ts', 'apps/realtime/package.json'],
        removedPackages: ['@w/realtime'],
        removedPatterns: ['apps/realtime', 'packages/redis/src/ticket*.ts'],
      });
      assert({
        given: 'a tree importing and mentioning removed modules',
        should: 'list each reference with its kind and location',
        actual: refs.map(({ file, line, kind, target }) => ({
          file,
          line,
          kind,
          target,
        })),
        expected: [
          {
            file: 'packages/redis/src/index.ts',
            line: 1,
            kind: 'import',
            target: 'packages/redis/src/ticket.ts',
          },
          {
            file: 'apps/web/src/a.ts',
            line: 1,
            kind: 'import',
            target: '@w/realtime',
          },
          {
            file: 'knip.jsonc',
            line: 1,
            kind: 'mention',
            target: 'apps/realtime',
          },
        ],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
