import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  checkDrive,
  failureLines,
  NO_CHECK_CREDENTIAL,
} from './drive-bootstrap-check';
import { HttpError, readOnly, type Transport } from './drive-bootstrap-inspect';
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

  test('with only the drive key holding another editing role', async () => {
    const fake = seeded();
    await bootstrap(fake);
    const driveId = fake.drives[0]?.id ?? '';
    fake.roles.push({
      id: 'rEditor0000000000000000',
      driveId,
      name: 'Editor',
      driveWidePermissions: { canView: true, canEdit: true, canShare: false },
    });
    fake.key.role = 'rEditor0000000000000000';
    assert({
      given:
        'a refused roles listing and a key that can edit the Roadmap but holds a custom "Editor" role',
      should: 'fail the role check by the role name the key reports',
      actual: await check(
        fake,
        { bootstrap: false, agentKey: true },
        { rolesRefused: true },
      ),
      expected: {
        code: 1,
        report: [
          'drive check FAILED:',
          '  - PAGESPACE_TOKEN: does not hold the "Agent" role: rerun `bun drive:bootstrap` to mint a key with the Agent role, then revoke the old one (`pagespace keys list`, `pagespace keys revoke`)',
          'not checked:',
          '  - agentRole: the "Agent" role\'s drive-wide grants were not checked (listing roles needs an owner key: set PAGESPACE_BOOTSTRAP_TOKEN)',
        ].join('\n'),
      },
    });
  });

  test('with a key PageSpace refuses', async () => {
    const fake = seeded();
    await bootstrap(fake);
    const refused: Transport = {
      ...readOnly(fake.transport),
      api: () =>
        Promise.reject(
          new HttpError(
            401,
            'PageSpace GET /api/drives → 401: Invalid MCP token',
          ),
        ),
    };
    const envText = fake.files.get(paths.env) ?? '';
    assert({
      given: 'only a bogus .env PAGESPACE_TOKEN',
      should:
        'fail as a credential error that names PAGESPACE_TOKEN and how to replace it',
      actual: await checkDrive(configOf(fake), manifest, envText, {
        bootstrap: null,
        agentKey: refused,
      }),
      expected: {
        code: 2,
        report:
          "drive:bootstrap --check: PageSpace refused .env's PAGESPACE_TOKEN (PageSpace GET /api/drives → 401: Invalid MCP token). " +
          'Check PAGESPACE_TOKEN in .env, or rerun `bun drive:bootstrap` (with PAGESPACE_BOOTSTRAP_TOKEN set) to mint a new Agent key, ' +
          'then revoke the old one (`pagespace keys list`, `pagespace keys revoke`).',
      },
    });
    assert({
      given: 'a bogus PAGESPACE_BOOTSTRAP_TOKEN beside a valid drive key',
      should: 'name PAGESPACE_BOOTSTRAP_TOKEN as the refused credential',
      actual: await checkDrive(configOf(fake), manifest, envText, {
        bootstrap: refused,
        agentKey: readOnly(fake.agentKeyTransport()),
      }),
      expected: {
        code: 2,
        report:
          'drive:bootstrap --check: PageSpace refused PAGESPACE_BOOTSTRAP_TOKEN (PageSpace GET /api/drives → 401: Invalid MCP token). ' +
          'Set it to a live unscoped key (see the header of scripts/drive-bootstrap.ts), ' +
          "or unset it to check with .env's PAGESPACE_TOKEN.",
      },
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

describe('drive:bootstrap failure output', () => {
  const error = new Error('PageSpace GET /api/drives → 500: boom');
  const failed =
    'drive:bootstrap failed: PageSpace GET /api/drives → 500: boom';

  test('offers the resume hint only when the run writes', () => {
    assert({
      given: 'a provisioning run that throws',
      should: 'print the failure and the resume hint',
      actual: failureLines([], error),
      expected: [
        failed,
        'Ids created so far are saved in project.config.json; rerun to resume.',
      ],
    });
    assert({
      given: '--check or --dry-run that throws',
      should: 'print the failure without a resume hint: nothing was written',
      actual: [
        failureLines(['--check'], error),
        failureLines(['--dry-run'], error),
      ],
      expected: [[failed], [failed]],
    });
  });
});
