import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { renameText } from './rename';
import {
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
    const busy = new Set([15432, 6379, 3000, 3012]);
    assert({
      given: 'the default ports busy, and realtime taken for app port 3001',
      should:
        'move each to the next free port whose whole app family (app, +11, +100..+103) is free',
      actual: pickPorts((port) => !busy.has(port)),
      expected: { postgres: 15433, redis: 6380, app: 3002 },
    });
  });
});

describe('stackEnv', () => {
  test('renamed .env.example', () => {
    const values = stackEnv(exampleEnv, 'widget-app', {
      postgres: 25432,
      redis: 16379,
      app: 3000,
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
      expected: {
        postgres: 'ZED_POSTGRES_PORT',
        redis: 'ZED_REDIS_PORT',
        app: 'ZED_APP_PORT',
      },
    });
  });

  test('moved app port', () => {
    assert({
      given: 'an app port moved off the default',
      should:
        'write the app port variable, which bun slot:up derives every app port from',
      actual: stackEnv('', 'zed', { postgres: 15432, redis: 6379, app: 3002 }),
      expected: {
        ZED_POSTGRES_PORT: '15432',
        ZED_REDIS_PORT: '6379',
        ZED_APP_PORT: '3002',
      },
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
