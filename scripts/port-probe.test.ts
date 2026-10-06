import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { isPortFree, portFreeWith } from './port-probe';

setupRitewayBun();

/** Holds an ephemeral port on `hostname` while `check` runs. */
function whileListening<T>(hostname: string, check: (port: number) => T): T {
  const listener = Bun.listen({ hostname, port: 0, socket: { data() {} } });
  try {
    return check(listener.port);
  } finally {
    listener.stop(true);
  }
}

describe('isPortFree', () => {
  test('an IPv4 wildcard listener', () => {
    assert({
      given: 'another process listening on 0.0.0.0 (how realtime listens)',
      should: 'report the port taken',
      actual: whileListening('0.0.0.0', isPortFree),
      expected: false,
    });
  });

  test('an IPv6 wildcard listener', () => {
    assert({
      given: 'another process listening on :: (how next dev listens)',
      should: 'report the port taken',
      actual: whileListening('::', isPortFree),
      expected: false,
    });
  });

  test('a loopback-only listener', () => {
    assert({
      given: 'another process listening on 127.0.0.1 only (a Docker port)',
      should: 'report the port taken',
      actual: whileListening('127.0.0.1', isPortFree),
      expected: false,
    });
  });

  test('a released port', () => {
    const port = whileListening('0.0.0.0', (held) => held);
    assert({
      given: 'a port whose listener has stopped',
      should: 'report it free',
      actual: isPortFree(port),
      expected: true,
    });
  });
});

describe('portFreeWith', () => {
  const refusing =
    (refused: Readonly<Record<string, string>>) =>
    (hostname: string): void => {
      const code = refused[hostname];
      if (code) throw Object.assign(new Error(`listen ${hostname}`), { code });
    };

  test('a host without IPv6', () => {
    assert({
      given: ':: refused with EADDRNOTAVAIL, then with EAFNOSUPPORT',
      should: 'still report the port free: IPv6 is missing, not busy',
      actual: [
        portFreeWith(refusing({ '::': 'EADDRNOTAVAIL' }))(3000),
        portFreeWith(refusing({ '::': 'EAFNOSUPPORT' }))(3000),
      ],
      expected: [true, true],
    });
  });

  test('a busy or unbindable address', () => {
    assert({
      given:
        ':: in use, 0.0.0.0 in use, and 127.0.0.1 refused with EADDRNOTAVAIL',
      should: 'report the port taken in each case',
      actual: [
        portFreeWith(refusing({ '::': 'EADDRINUSE' }))(3000),
        portFreeWith(refusing({ '0.0.0.0': 'EADDRINUSE' }))(3000),
        portFreeWith(refusing({ '127.0.0.1': 'EADDRNOTAVAIL' }))(3000),
      ],
      expected: [false, false, false],
    });
  });
});
