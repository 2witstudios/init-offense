import { expect } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  parsePortBlockComment,
  pickPortBlock,
  portBlockComment,
  portBlockPorts,
} from './slot-ports';

setupRitewayBun();

describe('port blocks', () => {
  test('keeps an existing claim and otherwise takes the lowest free block', () => {
    assert({
      given: 'claims by other slots and one busy block',
      should: 'reuse the own claim, else skip claimed and busy blocks',
      actual: [
        pickPortBlock({ own: 7, claimed: [1, 2], isFree: () => false }),
        pickPortBlock({ claimed: [1, 2], isFree: (block) => block !== 3 }),
      ],
      expected: [7, 4],
    });
  });

  test('round-trips the claim stored on the slot database', () => {
    assert({
      given: 'a port block comment and foreign comments',
      should: 'parse only the exact claim format',
      actual: [
        parsePortBlockComment(portBlockComment(12)),
        parsePortBlockComment('acme-slot port-block=12; drop'),
        parsePortBlockComment(null),
      ],
      expected: [12, undefined, undefined],
    });
    expect(() => portBlockComment(0)).toThrow(/port block/);
  });

  test("reserves the app, its three web e2e ports and realtime's e2e and dev ports", () => {
    assert({
      given: 'port block 2',
      should: 'list all six ports slotEnvValues can hand out for that block',
      actual: portBlockPorts(2),
      expected: [13020, 13021, 13022, 13023, 13024, 13025],
    });
  });
});
