import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { checkDrive, NO_CHECK_CREDENTIAL } from './drive-bootstrap-check';
import { readOnly } from './drive-bootstrap-inspect';
import { paths } from './drive-bootstrap-fake.test-support';
import {
  bootstrap,
  configOf,
  manifest,
  seeded,
  type Fake,
} from './drive-bootstrap-run.test-support';

setupRitewayBun();

describe('drive:bootstrap --check credentials', () => {
  const PASSED =
    'drive check: every configured id exists in the drive with the expected type, and PAGESPACE_TOKEN holds the Agent role and can edit.';
  const check = (
    fake: Fake,
    credentials: { bootstrap: boolean; agentKey: boolean },
    agentOptions: { rolesRefused?: boolean } = {},
  ) =>
    checkDrive(configOf(fake), manifest, fake.files.get(paths.env) ?? '', {
      bootstrap: credentials.bootstrap ? readOnly(fake.transport) : null,
      agentKey: credentials.agentKey
        ? readOnly(fake.agentKeyTransport(agentOptions))
        : null,
    });
  const ownerReads = (fake: Fake, from: number) =>
    fake.calls.slice(from).filter((call) => call.path.includes('/roles'))
      .length;

  test('with the bootstrap token', async () => {
    const fake = seeded();
    await bootstrap(fake);
    assert({
      given: 'PAGESPACE_BOOTSTRAP_TOKEN and the drive key',
      should: 'check everything and pass',
      actual: await check(fake, { bootstrap: true, agentKey: true }),
      expected: { code: 0, report: PASSED },
    });
  });

  test('with only the drive key', async () => {
    const fake = seeded();
    await bootstrap(fake);
    const before = fake.calls.length;
    assert({
      given: 'only .env PAGESPACE_TOKEN (the setup key already revoked)',
      should: 'read the drive, its roles and the key with it and pass',
      actual: [
        await check(fake, { bootstrap: false, agentKey: true }),
        ownerReads(fake, before),
      ],
      expected: [{ code: 0, report: PASSED }, 1],
    });
    assert({
      given: 'only the drive key, and a roles listing refused to it',
      should:
        'still verify pages and the key by its role name, and report the role grants as not checked',
      actual: await check(
        fake,
        { bootstrap: false, agentKey: true },
        { rolesRefused: true },
      ),
      expected: {
        code: 0,
        report: [
          PASSED,
          'not checked:',
          '  - agentRole: the "Agent" role\'s drive-wide grants were not checked (listing roles needs an owner key: set PAGESPACE_BOOTSTRAP_TOKEN)',
        ].join('\n'),
      },
    });
    fake.key.role = 'member';
    assert({
      given: 'only the drive key, a refused roles listing and a MEMBER key',
      should: 'still fail on what the key itself reports',
      actual: (
        await check(
          fake,
          { bootstrap: false, agentKey: true },
          { rolesRefused: true },
        )
      ).code,
      expected: 1,
    });
  });

  test('with no credential', async () => {
    const fake = seeded();
    await bootstrap(fake);
    const before = fake.calls.length;
    assert({
      given: 'neither PAGESPACE_BOOTSTRAP_TOKEN nor PAGESPACE_TOKEN',
      should: 'refuse without a request and say how to get the drive key',
      actual: [
        await check(fake, { bootstrap: false, agentKey: false }),
        fake.calls.length - before,
      ],
      expected: [{ code: 2, report: NO_CHECK_CREDENTIAL }, 0],
    });
  });
});
