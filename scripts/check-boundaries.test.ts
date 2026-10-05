import {
  adminSurfaceIssue,
  allowedWorkspaceDependencies,
  deepImportIssue,
  domainPurityIssue,
  pureWorkspaces,
  forbiddenDependencyIssue,
} from './boundaries-rules';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';

setupRitewayBun();

const workspaces = [
  '@acme/web',
  '@acme/domain',
  '@acme/protocol',
  '@acme/db',
  '@acme/redis',
  '@acme/auth',
  '@acme/errors',
  '@acme/config',
  '@acme/clock',
  '@acme/logger',
  '@acme/observability',
  '@acme/typescript-config',
] as const;

describe('domain purity rule', () => {
  for (const name of workspaces) {
    if (name === '@acme/domain') continue;
    test(`${name} is not subject to the domain purity rule`, () => {
      assert({
        given: `${name} declaring and importing a third-party package`,
        should: 'report no purity issue',
        actual: [
          domainPurityIssue(name, 'zod', 'dependency'),
          domainPurityIssue(name, 'node:fs', 'import', 'packages/x/src/a.ts'),
        ],
        expected: [null, null],
      });
    });
  }

  test('the domain may not declare a third-party runtime dependency', () => {
    assert({
      given: '@acme/domain declaring zod',
      should: 'report a purity issue',
      actual: domainPurityIssue('@acme/domain', 'zod', 'dependency'),
      expected: '@acme/domain: dependency zod breaks domain purity',
    });
  });

  test('domain production code may not import platform or vendor modules', () => {
    assert({
      given: 'domain source importing node:fs, bun and drizzle-orm',
      should: 'report a purity issue for each',
      actual: ['node:fs', 'bun', 'drizzle-orm'].map((specifier) =>
        domainPurityIssue(
          '@acme/domain',
          specifier,
          'import',
          'packages/domain/src/project.ts',
        ),
      ),
      expected: [
        '@acme/domain: import node:fs breaks domain purity',
        '@acme/domain: import bun breaks domain purity',
        '@acme/domain: import drizzle-orm breaks domain purity',
      ],
    });
  });

  test('workspace, relative and test-runner imports stay allowed', () => {
    assert({
      given:
        'domain importing @acme/errors, a sibling module, and riteway from a test',
      should: 'report no issue',
      actual: [
        domainPurityIssue(
          '@acme/domain',
          '@acme/errors',
          'import',
          'packages/domain/src/project.ts',
        ),
        domainPurityIssue(
          '@acme/domain',
          './invariant-ids',
          'import',
          'packages/domain/src/project.ts',
        ),
        domainPurityIssue(
          '@acme/domain',
          'riteway/bun',
          'import',
          'packages/domain/src/project.test.ts',
        ),
      ],
      expected: [null, null, null],
    });
  });

  test('the pure set is exactly the domain', () => {
    assert({
      given: 'the pure workspace list',
      should: 'name exactly @acme/domain',
      actual: [...pureWorkspaces],
      expected: ['@acme/domain'],
    });
  });

  test('the domain depends on errors only', () => {
    assert({
      given: 'the domain declaring @acme/db',
      should: 'report a forbidden dependency',
      actual: forbiddenDependencyIssue(
        'packages/domain',
        '@acme/domain',
        '@acme/db',
        allowedWorkspaceDependencies,
      ),
      expected: 'packages/domain: forbidden dependency @acme/db',
    });
  });
});

describe('realtime workspace edges (ADR 0031 §12)', () => {
  test('the allowlist names exactly the ADR 0031 §12 edges', () => {
    assert({
      given: 'allowedWorkspaceDependencies.realtime',
      should: 'list exactly the edges the ADR mechanically enforces',
      actual: [...allowedWorkspaceDependencies.realtime!].sort(),
      expected: [
        'auth',
        'clock',
        'config',
        'db',
        'errors',
        'logger',
        'observability',
        'protocol',
        'redis',
      ].sort(),
    });
  });

  test('a realtime manifest depending on domain is forbidden', () => {
    assert({
      given: 'apps/realtime declaring @acme/domain',
      should: 'report a forbidden dependency',
      actual: forbiddenDependencyIssue(
        'apps/realtime',
        '@acme/realtime',
        '@acme/domain',
        allowedWorkspaceDependencies,
      ),
      expected: 'apps/realtime: forbidden dependency @acme/domain',
    });
  });

  test('a realtime manifest depending on apps/web is forbidden', () => {
    assert({
      given: 'apps/realtime declaring @acme/web',
      should: 'report a forbidden dependency',
      actual: forbiddenDependencyIssue(
        'apps/realtime',
        '@acme/realtime',
        '@acme/web',
        allowedWorkspaceDependencies,
      ),
      expected: 'apps/realtime: forbidden dependency @acme/web',
    });
  });

  test('a realtime manifest depending on one of its allowed edges is not flagged', () => {
    assert({
      given: 'apps/realtime declaring @acme/protocol',
      should: 'report no issue',
      actual: forbiddenDependencyIssue(
        'apps/realtime',
        '@acme/realtime',
        '@acme/protocol',
        allowedWorkspaceDependencies,
      ),
      expected: null,
    });
  });

  test('deleting the realtime key removes the restriction entirely', () => {
    const withoutRealtime = Object.fromEntries(
      Object.entries(allowedWorkspaceDependencies).filter(
        ([key]) => key !== 'realtime',
      ),
    );

    assert({
      given: 'the realtime key removed from allowedWorkspaceDependencies',
      should:
        'no longer forbid @acme/domain, proving the fixture is load-bearing',
      actual: forbiddenDependencyIssue(
        'apps/realtime',
        '@acme/realtime',
        '@acme/domain',
        withoutRealtime,
      ),
      expected: null,
    });
  });
});

describe('workspace deep imports', () => {
  const exportsOf = (name: string) =>
    name === '@acme/errors'
      ? { '.': './src/index.ts', './testing': './src/testing.ts' }
      : { '.': './src/index.ts' };

  test('admits a package root and a subpath the package exports', () => {
    assert({
      given: "a package's root and a subpath named in its exports map",
      should: 'report no issue for either',
      actual: [
        deepImportIssue('@acme/errors', exportsOf),
        deepImportIssue('@acme/errors/testing', exportsOf),
      ],
      expected: [null, null],
    });
  });

  test('refuses a subpath the package does not export', () => {
    assert({
      given: 'a reach into a source file the exports map does not name',
      should: 'report the deep import',
      actual: [
        deepImportIssue('@acme/errors/src/index', exportsOf),
        deepImportIssue('@acme/db/schema', exportsOf),
      ],
      expected: [
        'workspace deep import @acme/errors/src/index',
        'workspace deep import @acme/db/schema',
      ],
    });
  });

  test('ignores packages outside the workspace', () => {
    assert({
      given: 'a subpath import of a third-party package',
      should: 'leave it to the dependency rules',
      actual: deepImportIssue('drizzle-orm/pg-core', exportsOf),
      expected: null,
    });
  });
});

describe('no admin surface in the participant app (ADR 0043)', () => {
  test('flags an admin route segment under the app router', () => {
    assert({
      given:
        'a route segment named admin, plain or grouped, under apps/web/src/app',
      should: 'report an admin surface issue',
      actual: [
        'apps/web/src/app/admin/page.tsx',
        'apps/web/src/app/(admin)/dashboard/page.tsx',
        'apps/web/src/app/api/admin/route.ts',
      ].map((file) => adminSurfaceIssue(file)),
      expected: [
        'apps/web/src/app/admin/page.tsx: admin surface in the participant app (ADR 0043)',
        'apps/web/src/app/(admin)/dashboard/page.tsx: admin surface in the participant app (ADR 0043)',
        'apps/web/src/app/api/admin/route.ts: admin surface in the participant app (ADR 0043)',
      ],
    });
  });

  test('flags a feature or module named admin anywhere under apps/web', () => {
    assert({
      given: 'a feature directory or a module file named admin',
      should: 'report an admin surface issue',
      actual: [
        'apps/web/src/features/admin/index.ts',
        'apps/web/src/lib/admin.ts',
        'apps/web/src/ui/admin.test.tsx',
      ].map((file) => adminSurfaceIssue(file)),
      expected: [
        'apps/web/src/features/admin/index.ts: admin surface in the participant app (ADR 0043)',
        'apps/web/src/lib/admin.ts: admin surface in the participant app (ADR 0043)',
        'apps/web/src/ui/admin.test.tsx: admin surface in the participant app (ADR 0043)',
      ],
    });
  });

  test('leaves ordinary participant routes, features and near-miss names alone', () => {
    assert({
      given:
        'legitimate participant paths and names that merely start with admin',
      should: 'report no issue',
      actual: [
        'apps/web/src/app/(shell)/profile/page.tsx',
        'apps/web/src/features/access/index.ts',
        'apps/web/src/lib/administration.ts',
        'packages/db/src/slots.ts',
      ].map((file) => adminSurfaceIssue(file)),
      expected: [null, null, null, null],
    });
  });
});
