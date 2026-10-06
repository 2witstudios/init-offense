import { expect } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  classifyCheckout,
  cloneSlotId,
  findOrphans,
  mainRecordOf,
  ownershipRefusal,
  parseSlotClaim,
  slotClaimComment,
  type MainRecord,
} from './slot-ownership';
import { worktreeSlot } from './slot-model';
import { slotNaming } from './slot-naming';

setupRitewayBun();

const { databaseBase: mainDatabase, namespaceBase: mainNamespace } =
  slotNaming('acme');
const main = '/repo/acme';
const clone = '/tmp/review/acme';
const recordedMain: MainRecord = { state: 'recorded', checkout: main };
const liveOnly =
  (...paths: string[]) =>
  (path: string) =>
    paths.includes(path);

describe('slot claim comment', () => {
  test('round-trips a port block and checkout path', () => {
    const path = '/Users/Ana Lu/dev/Acme Project';
    assert({
      given: 'claims with and without a port block, and foreign comments',
      should: 'parse only the exact claim format',
      actual: [
        parseSlotClaim(slotClaimComment({ portBlock: 12, checkout: path })),
        parseSlotClaim(slotClaimComment({ checkout: path })),
        parseSlotClaim(slotClaimComment({ portBlock: 12 })),
        parseSlotClaim('acme-slot port-block=12; drop'),
        parseSlotClaim('acme-slot checkout=2f7'),
        parseSlotClaim(null),
      ],
      expected: [
        { portBlock: 12, checkout: path },
        { checkout: path },
        { portBlock: 12 },
        {},
        {},
        {},
      ],
    });
  });

  test('stays inside the database comment allowlist', () => {
    assert({
      given: "a path with quotes, slashes and capitals ('; DROP)",
      should: 'encode it to lowercase letters, digits, spaces and =',
      actual: /^[a-z0-9 =-]+$/.test(
        slotClaimComment({ portBlock: 3, checkout: "/x/'; DROP DATABASE A" }),
      ),
      expected: true,
    });
    expect(() => slotClaimComment({ portBlock: 0 })).toThrow(/port block/);
  });
});

describe('main record', () => {
  test('reads the owner from the main database comment', () => {
    const recorded = slotClaimComment({ checkout: main });
    const test = { name: `${mainDatabase}_test`, comment: null };
    assert({
      given:
        'no main database, the image-created one, a set-up one without a record, and a recorded one',
      should: 'report absent, absent, unrecorded and the recorded path',
      actual: [
        mainRecordOf([{ name: 'acme_wt_a', comment: null }]),
        mainRecordOf([{ name: mainDatabase, comment: null }]),
        mainRecordOf([{ name: mainDatabase, comment: null }, test]),
        mainRecordOf([{ name: mainDatabase, comment: recorded }, test]),
      ],
      expected: [
        { state: 'absent' },
        { state: 'absent' },
        { state: 'unrecorded' },
        { state: 'recorded', checkout: main },
      ],
    });
  });
});

describe('checkout classification', () => {
  test('the recorded main checkout keeps the main slot', () => {
    assert({
      given: 'the checkout recorded on the main database',
      should: 'get the main slot without reclaiming it',
      actual: classifyCheckout({
        checkout: main,
        gitMain: main,
        main: recordedMain,
        isLive: liveOnly(main),
      }),
      expected: {
        slot: {
          kind: 'main',
          id: mainDatabase,
          database: mainDatabase,
          testDatabase: `${mainDatabase}_test`,
          e2eDatabase: `${mainDatabase}_e2e`,
          namespace: mainNamespace,
          e2eNamespace: `${mainNamespace}-e2e`,
        },
        claimsMain: false,
      },
    });
  });

  test('the first repository main checkout claims a missing main slot', () => {
    assert({
      given: 'no main database yet',
      should: 'get the main slot and claim it',
      actual: classifyCheckout({
        checkout: main,
        gitMain: main,
        main: { state: 'absent' },
        isLive: liveOnly(),
      }).claimsMain,
      expected: true,
    });
  });

  test('a git worktree derives its slot from its folder', () => {
    assert({
      given: 'a git worktree of either the main checkout or a clone',
      should: 'get the folder slot',
      actual: [main, clone].map(
        (gitMain) =>
          classifyCheckout({
            checkout: `${gitMain}/.pu/worktrees/wt-3ctbm0tw`,
            gitMain,
            main: recordedMain,
            isLive: liveOnly(main, clone),
          }).slot,
      ),
      expected: [worktreeSlot('3ctbm0tw'), worktreeSlot('3ctbm0tw')],
    });
  });

  test('a standalone clone elsewhere gets a clone slot, never the main names', () => {
    const { slot, claimsMain } = classifyCheckout({
      checkout: clone,
      gitMain: clone,
      main: recordedMain,
      isLive: liveOnly(main, clone),
    });
    const mainNames = [
      mainDatabase,
      `${mainDatabase}_test`,
      `${mainDatabase}_e2e`,
      mainNamespace,
      `${mainNamespace}-e2e`,
    ];
    assert({
      given: 'a clone of the same repository while the main checkout lives',
      should: 'derive a worktree-kind slot keyed by a hash of its path',
      actual: {
        slot,
        claimsMain,
        sharesAName: [
          slot.database,
          slot.testDatabase,
          slot.e2eDatabase,
          slot.namespace,
          slot.e2eNamespace,
        ].some((name) => mainNames.includes(name)),
      },
      expected: {
        slot: worktreeSlot(cloneSlotId(clone)),
        claimsMain: false,
        sharesAName: false,
      },
    });
  });

  test('a moved clone gets a new slot', () => {
    const moved = '/tmp/review2/acme';
    const slotAt = (checkout: string) =>
      classifyCheckout({
        checkout,
        gitMain: checkout,
        main: recordedMain,
        isLive: liveOnly(main, moved),
      }).slot.id;
    assert({
      given: 'the same clone before and after a move',
      should: 'derive a stable id per path and a different one after moving',
      actual: [
        slotAt(clone) === slotAt(clone),
        slotAt(clone) === slotAt(moved),
        /^clone_[0-9a-f]{8}$/.test(slotAt(moved)),
      ],
      expected: [true, false, true],
    });
  });

  test('keeps a clone id inside a long slug budget', () => {
    assert({
      given: 'the smallest id budget a slug may leave',
      should: 'shorten the id to fit',
      actual: /^c[0-9a-f]{7}$/.test(cloneSlotId(clone, 8)),
      expected: true,
    });
  });

  test('refuses to guess when the main owner is unknown', () => {
    const attempt = (record: MainRecord) => () =>
      classifyCheckout({
        checkout: clone,
        gitMain: clone,
        main: record,
        isLive: liveOnly(clone),
      });
    expect(attempt({ state: 'unrecorded' })).toThrow(/--claim-main/);
    expect(attempt({ state: 'recorded', checkout: '/gone/acme' })).toThrow(
      /no longer exists/,
    );
  });

  test('--claim-main takes an unrecorded or abandoned main slot only', () => {
    const claim = (record: MainRecord, checkout = main) =>
      classifyCheckout({
        checkout,
        gitMain: checkout,
        main: record,
        isLive: liveOnly(main, clone),
        claimMain: true,
      });
    assert({
      given: 'an unrecorded main slot and one whose checkout moved away',
      should: 'claim the main slot',
      actual: [
        claim({ state: 'unrecorded' }),
        claim({ state: 'recorded', checkout: '/old/acme' }),
      ].map(({ slot, claimsMain }) => [slot.kind, claimsMain]),
      expected: [
        ['main', true],
        ['main', true],
      ],
    });
    expect(() => claim(recordedMain, clone)).toThrow(/live checkout/);
    expect(() =>
      classifyCheckout({
        checkout: `${main}/wt-a`,
        gitMain: main,
        main: recordedMain,
        isLive: liveOnly(main),
        claimMain: true,
      }),
    ).toThrow(/git worktree/);
  });
});

describe('slot ownership', () => {
  const slot = worktreeSlot('feature');
  test('refuses only a slot recorded for another live checkout', () => {
    const refusal = (recorded: string | undefined) =>
      ownershipRefusal({
        slot,
        checkout: '/a/feature',
        recorded,
        isLive: liveOnly('/a/feature', '/b/feature'),
      });
    assert({
      given: 'no record, its own record, a dead record and a live foreign one',
      should: 'refuse only the live foreign owner',
      actual: [
        refusal(undefined),
        refusal('/a/feature'),
        refusal('/gone/feature'),
        refusal('/b/feature'),
      ].map((value) => value === undefined),
      expected: [true, true, true, false],
    });
  });
});

describe('pruning safety', () => {
  const claim = (checkout: string, portBlock = 1) =>
    slotClaimComment({ portBlock, checkout });
  const databases = [
    { name: 'acme_wt_live', comment: claim('/clone/acme') },
    { name: 'acme_wt_live_test', comment: null },
    { name: 'acme_wt_gone', comment: claim('/deleted/acme', 2) },
    { name: 'acme_wt_gone_test', comment: null },
    { name: 'acme_wt_gone_test_run_0a1b2c3d', comment: null },
    { name: 'acme_wt_legacy', comment: slotClaimComment({ portBlock: 3 }) },
    { name: 'acme_wt_own', comment: claim('/deleted/own', 4) },
    { name: 'acme_wt_Bad', comment: null },
  ];
  const namespaces = [
    mainNamespace,
    'acme-wt-live',
    'acme-wt-gone',
    'acme-wt-gone-e2e',
    'acme-wt-legacy',
    'acme-wt-own',
    'acme-wt-',
  ];
  const isLive = liveOnly('/clone/acme');

  test('keeps a live foreign slot and drops a slot of a deleted path', () => {
    assert({
      given: 'a clone with no authority over unrecorded slots',
      should:
        'drop only the slot whose recorded checkout is gone, never its own or a legacy one',
      actual: findOrphans({ ownId: 'own', databases, namespaces, isLive }),
      expected: {
        ids: ['gone'],
        databases: [
          'acme_wt_gone',
          'acme_wt_gone_test',
          'acme_wt_gone_test_run_0a1b2c3d',
        ],
        namespaces: ['acme-wt-gone', 'acme-wt-gone-e2e'],
      },
    });
  });

  test('drops an unrecorded slot only with the main repository worktree list', () => {
    assert({
      given: 'the main repository, whose git worktrees do not list legacy',
      should: 'also drop the unrecorded slot git no longer lists',
      actual: findOrphans({
        databases,
        namespaces,
        isLive,
        legacyLiveIds: ['live'],
      }).ids,
      expected: ['gone', 'legacy', 'own'],
    });
  });
});
