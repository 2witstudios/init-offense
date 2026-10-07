/** The real readiness probe: what counts as the app answering. */
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { reachable } from './wizard-io';

setupRitewayBun();

/** Serves `status` on an ephemeral port while `check` probes it. */
async function withStatus(
  status: number,
  check: (url: string) => Promise<void>,
): Promise<void> {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response(null, { status }),
  });
  try {
    await check(`http://127.0.0.1:${server.port}`);
  } finally {
    server.stop(true);
  }
}

/** A port this host is not listening on while `check` probes it. */
async function withClosedPort(
  check: (url: string) => Promise<void>,
): Promise<void> {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response(),
  });
  const url = `http://127.0.0.1:${server.port}`;
  server.stop(true);
  await check(url);
}

describe('reachable', () => {
  test('the sign-in page answering', async () => {
    await withStatus(200, async (url) =>
      assert({
        given: 'an HTTP 200 response',
        should: 'report the app ready',
        actual: await reachable(url),
        expected: true,
      }),
    );
  });

  test('a redirect', async () => {
    await withStatus(302, async (url) =>
      assert({
        given: 'an HTTP 302 response',
        should: 'still report the app ready: a redirect is the app answering',
        actual: await reachable(url),
        expected: true,
      }),
    );
  });

  test('an error response', async () => {
    await withStatus(500, async (url) =>
      assert({
        given: 'an HTTP 500 response',
        should: 'report the app not ready',
        actual: await reachable(url),
        expected: false,
      }),
    );
  });

  test('nothing listening', async () => {
    await withClosedPort(async (url) =>
      assert({
        given: 'a port nothing listens on',
        should: 'report the app not ready',
        actual: await reachable(url),
        expected: false,
      }),
    );
  });
});
