import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { renameText } from './rename';
import {
  appEnv,
  findFreePort,
  pickPorts,
  readEnv,
  setEnv,
  stackEnv,
  stackPortKeys,
} from './wizard-env';

setupRitewayBun();

const exampleEnv = renameText(
  readFileSync(join(import.meta.dir, '..', '.env.example'), 'utf8'),
  { slug: 'widget-app', display: 'Widget App' },
);

describe('findFreePort', () => {
  test('probing', () => {
    const busy = new Set([15432, 15433, 3000]);
    const isFree = (port: number) => !busy.has(port);
    assert({
      given: '15432 and 15433 busy',
      should: 'pick the next free port, skipping ones already taken',
      actual: [
        findFreePort(15432, isFree),
        findFreePort(15432, isFree, [15434]),
        findFreePort(1, () => false),
      ],
      expected: [15434, 15435, null],
    });
  });

  test('pickPorts', () => {
    const busy = new Set([15432, 6379, 3000, 3001, 3011]);
    assert({
      given: 'the default ports busy',
      should: 'move each one to the next distinct free port',
      actual: pickPorts((port) => !busy.has(port)),
      expected: { postgres: 15433, redis: 6380, app: 3002, realtime: 3012 },
    });
  });
});

describe('stackEnv', () => {
  test('renamed .env.example', () => {
    const values = stackEnv(exampleEnv, 'widget-app', {
      postgres: 25432,
      redis: 16379,
    });
    assert({
      given: 'the template .env.example renamed for widget-app',
      should:
        "set the project's compose port variables and move every stack URL",
      actual: values,
      expected: {
        WIDGET_APP_POSTGRES_PORT: '25432',
        WIDGET_APP_REDIS_PORT: '16379',
        DATABASE_URL:
          'postgres://widget_app:local-development-only@localhost:25432/widget_app',
        TEST_DATABASE_URL:
          'postgres://widget_app:local-development-only@localhost:25432/widget_app_test',
        E2E_DATABASE_URL:
          'postgres://widget_app_e2e:e2e-loopback-only@localhost:25432/widget_app_e2e',
        REDIS_URL: 'redis://localhost:16379',
        TEST_REDIS_URL: 'redis://localhost:16379/1',
        E2E_REDIS_URL: 'redis://localhost:16379/2',
      },
    });
  });

  test('stackPortKeys', () => {
    assert({
      given: 'a one-word slug',
      should: 'use its SCREAMING_SNAKE form',
      actual: stackPortKeys('zed'),
      expected: { postgres: 'ZED_POSTGRES_PORT', redis: 'ZED_REDIS_PORT' },
    });
  });
});

describe('setEnv', () => {
  const before = '# keep me\nA=1\nSECRET=s3cret\n# B=commented\nB=2\n';
  const after = setEnv(before, { B: '3', C: '4' });

  test('rewrite', () => {
    assert({
      given: 'a .env with comments and unrelated keys',
      should: 'replace owned keys in place, append new ones and keep the rest',
      actual: after,
      expected: '# keep me\nA=1\nSECRET=s3cret\n# B=commented\nB=3\nC=4\n',
    });
  });

  test('round trip', () => {
    assert({
      given: 'the rewritten text',
      should: 'read the new values back',
      actual: [
        readEnv(after, 'B'),
        readEnv(after, 'SECRET'),
        readEnv(after, 'MISSING'),
      ],
      expected: ['3', 's3cret', undefined],
    });
  });

  test('no trailing newline', () => {
    assert({
      given: 'text without a final newline',
      should: 'append on a new line',
      actual: setEnv('A=1', { B: '2' }),
      expected: 'A=1\nB=2\n',
    });
  });
});

describe('appEnv', () => {
  test('defaults and moved', () => {
    assert({
      given: 'the default ports, then a moved app port',
      should: 'write nothing, then PORT, PUBLIC_APP_URL and REALTIME_PORT',
      actual: [
        appEnv({ app: 3000, realtime: 3011 }),
        appEnv({ app: 3002, realtime: 3011 }),
      ],
      expected: [
        {},
        {
          PORT: '3002',
          PUBLIC_APP_URL: 'http://localhost:3002',
          REALTIME_PORT: '3011',
        },
      ],
    });
  });
});
