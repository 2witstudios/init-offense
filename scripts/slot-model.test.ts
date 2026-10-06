import { expect } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  deriveSlot,
  liveWorktreeIds,
  parseWorktreeList,
  worktreeSlot,
} from './slot-model';
import { slotNaming } from './slot-naming';

setupRitewayBun();

const main = '/repo/acme';
// The main slot's database is the slug's snake form, its namespace the slug.
const { databaseBase: mainDatabase, namespaceBase: mainNamespace } =
  slotNaming('acme');
const redisNamespaceRule = /^[a-z][a-z0-9-]{0,62}$/;
const postgresIdentifierRule = /^[a-z_][a-z0-9_]{0,62}$/;

describe('slot derivation', () => {
  test('the main checkout is slot acme', () => {
    assert({
      given: 'the main checkout',
      should: 'keep the canonical database names and namespace',
      actual: deriveSlot({ checkout: main, mainCheckout: main }),
      expected: {
        kind: 'main',
        id: mainDatabase,
        database: mainDatabase,
        testDatabase: `${mainDatabase}_test`,
        e2eDatabase: `${mainDatabase}_e2e`,
        namespace: mainNamespace,
        e2eNamespace: `${mainNamespace}-e2e`,
      },
    });
  });

  test('a pu worktree folder maps to its own databases and namespace', () => {
    assert({
      given: 'a worktree folder named wt-3ctbm0tw',
      should: 'derive acme_wt_<id> names and a hyphenated namespace',
      actual: deriveSlot({
        checkout: '/repo/acme/.pu/worktrees/wt-3ctbm0tw',
        mainCheckout: main,
      }),
      expected: {
        kind: 'worktree',
        id: '3ctbm0tw',
        database: 'acme_wt_3ctbm0tw',
        testDatabase: 'acme_wt_3ctbm0tw_test',
        e2eDatabase: 'acme_wt_3ctbm0tw_e2e',
        namespace: 'acme-wt-3ctbm0tw',
        e2eNamespace: 'acme-wt-3ctbm0tw-e2e',
      },
    });
  });

  test('normalises case and separators of an ordinary folder name', () => {
    assert({
      given: 'a worktree folder named Feat-Login',
      should: 'lowercase it and use underscores in Postgres, hyphens in Redis',
      actual: [
        deriveSlot({ checkout: '/elsewhere/Feat-Login', mainCheckout: main })
          .database,
        worktreeSlot('feat_login').namespace,
      ],
      expected: ['acme_wt_feat_login', 'acme-wt-feat-login'],
    });
  });

  test('every derived identifier satisfies Postgres and REDIS_NAMESPACE', () => {
    const slot = deriveSlot({
      checkout: `/w/wt-${'a'.repeat(slotNaming('acme').maxIdLength)}`,
      mainCheckout: main,
    });
    assert({
      given: 'the longest accepted worktree id',
      should: 'produce valid identifiers for every name',
      actual: [
        postgresIdentifierRule.test(slot.database),
        postgresIdentifierRule.test(slot.testDatabase),
        postgresIdentifierRule.test(slot.e2eDatabase),
        redisNamespaceRule.test(slot.namespace),
        redisNamespaceRule.test(slot.e2eNamespace),
      ],
      expected: [true, true, true, true, true],
    });
  });

  test('rejects hostile and unrepresentable folder names', () => {
    for (const folder of [
      'wt-"; DROP DATABASE acme; --',
      "wt-a'b",
      'wt-a b',
      'wt-a.b',
      'wt-a*',
      'wt-a:b',
      'wt-',
      'wt-_a',
      'wt-a__b',
      'wt-a-',
      'wt-ünïcode',
      `wt-${'a'.repeat(slotNaming('acme').maxIdLength + 1)}`,
      'wt-a-test',
      'wt-a-e2e',
      'wt-a-test-run-0a1b2c3d',
    ])
      expect(() =>
        deriveSlot({ checkout: `/w/${folder}`, mainCheckout: main }),
      ).toThrow(/worktree folder/);
  });
});

describe('git worktree list parsing', () => {
  const porcelain = [
    'worktree /repo/acme',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree /repo/acme/.pu/worktrees/wt-aaaa1111',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/pu/a',
    '',
    'worktree /repo/acme/.pu/worktrees/wt-bbbb2222',
    'HEAD 3333333333333333333333333333333333333333',
    'detached',
    'prunable gitdir file points to non-existent location',
    '',
    'worktree /repo/acme/.pu/worktrees/wt-cccc3333',
    'HEAD 4444444444444444444444444444444444444444',
    'locked',
    '',
  ].join('\n');

  test('names the main checkout and every live worktree', () => {
    assert({
      given: 'porcelain output with a prunable (folder deleted) entry',
      should: 'treat the prunable entry as removed',
      actual: parseWorktreeList(porcelain),
      expected: {
        main: '/repo/acme',
        worktrees: [
          '/repo/acme/.pu/worktrees/wt-aaaa1111',
          '/repo/acme/.pu/worktrees/wt-cccc3333',
        ],
      },
    });
  });

  test('derives live worktree ids and refuses colliding folders', () => {
    assert({
      given: 'two live worktrees',
      should: 'list their slot ids',
      actual: liveWorktreeIds(['/x/wt-aaaa1111', '/y/feature-b']),
      expected: { ids: ['aaaa1111', 'feature_b'], unslotted: [] },
    });
    assert({
      given: 'a live worktree whose folder cannot be a slot',
      should: 'report it rather than guess an id',
      actual: liveWorktreeIds(['/x/wt-aaaa1111', '/x/bad.name']),
      expected: { ids: ['aaaa1111'], unslotted: ['/x/bad.name'] },
    });
    expect(() => liveWorktreeIds(['/x/wt-feature-b', '/y/feature_b'])).toThrow(
      /same slot/,
    );
  });
});
