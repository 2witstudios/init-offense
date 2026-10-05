import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  extractToken,
  keyIdByName,
  withTemporaryKey,
} from './wizard-pagespace';
import { fakeDeps } from './wizard.test-support';

setupRitewayBun();

const TOKEN = 'mcp_k3y5ecretvalue0123456789';
const LIST = JSON.stringify([
  { id: 'old', name: 'widget-setup', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'new', name: 'widget-setup', createdAt: '2026-10-05T00:00:00Z' },
  { id: 'other', name: 'ci', createdAt: '2026-10-05T00:00:00Z' },
]);

describe('extractToken', () => {
  test('formats', () => {
    assert({
      given:
        'the --show-token stdout contract, garbage, two tokens, and a non-mcp value',
      should: 'accept exactly one PAGESPACE_TOKEN=mcp_… line only',
      actual: [
        extractToken(`PAGESPACE_TOKEN=${TOKEN}\n`),
        extractToken(`PAGESPACE_TOKEN=${TOKEN}\r\n`),
        extractToken('Opening your browser…\n'),
        extractToken(`PAGESPACE_TOKEN=${TOKEN}\nPAGESPACE_TOKEN=${TOKEN}\n`),
        extractToken('PAGESPACE_TOKEN=ps_refresh_abcdefghijklmnopqrstu\n'),
        extractToken(`PAGESPACE_TOKEN=${TOKEN} extra\n`),
      ],
      expected: [TOKEN, TOKEN, null, null, null, null],
    });
  });
});

describe('keyIdByName', () => {
  test('lookup', () => {
    assert({
      given: 'keys list JSON with two keys of that name, and broken JSON',
      should: 'pick the newest id, and null when unreadable',
      actual: [
        keyIdByName(LIST, 'widget-setup'),
        keyIdByName(LIST, 'nope'),
        keyIdByName('nope', 'x'),
      ],
      expected: ['new', null, null],
    });
  });
});

const keyFake = (mintCode = 0) =>
  fakeDeps({
    probes: { 'pagespace keys list --json': { code: 0, stdout: LIST } },
    capture: () => ({
      code: mintCode,
      stdout: mintCode === 0 ? `PAGESPACE_TOKEN=${TOKEN}\n` : '',
    }),
  });

const revokeCommands = [
  'pagespace keys revoke new --yes',
  'pagespace logout --key=widget-setup',
];

describe('withTemporaryKey', () => {
  test('success', async () => {
    const fake = keyFake();
    let received = '';
    await withTemporaryKey(fake.deps, 'widget', false, (token) => {
      received = token;
    });
    assert({
      given: 'a successful mint',
      should: 'hand the token over, then revoke the key and forget it locally',
      actual: [received === TOKEN, fake.ran],
      expected: [
        true,
        [
          'pagespace keys create --all-drives --name widget-setup --show-token --yes',
          ...revokeCommands,
        ],
      ],
    });
    assert({
      given: 'everything the wizard displayed',
      should: 'never print the token',
      actual: fake.logs.some((line) => line.includes(TOKEN)),
      expected: false,
    });
  });

  test('use fails', async () => {
    const fake = keyFake();
    const outcome = await withTemporaryKey(fake.deps, 'widget', false, () => {
      throw new Error('bootstrap exploded');
    }).catch((error: Error) => error.message);
    assert({
      given: 'the bootstrap throwing',
      should: 'rethrow after revoking the key',
      actual: [outcome, fake.ran.slice(1)],
      expected: ['bootstrap exploded', revokeCommands],
    });
  });

  test('mint fails', async () => {
    const fake = keyFake(1);
    let used = false;
    const outcome = await withTemporaryKey(fake.deps, 'widget', false, () => {
      used = true;
    }).catch((error: Error) => error.message);
    assert({
      given: 'the key mint failing',
      should: 'never run the bootstrap, and still revoke any key of that name',
      actual: [used, outcome, fake.ran.slice(1)],
      expected: [
        false,
        'Creating the temporary PageSpace key failed (exit 1).',
        revokeCommands,
      ],
    });
  });

  test('dry run', async () => {
    const fake = keyFake();
    const received = await withTemporaryKey(
      fake.deps,
      'widget',
      true,
      (token) => token,
    );
    assert({
      given: 'a dry run',
      should: 'run nothing, pass a placeholder and still show the revoke',
      actual: [
        received,
        fake.ran,
        fake.logs.filter((line) => line.includes('[dry run]')).length,
      ],
      expected: ['<temporary key>', [], 4],
    });
  });
});
