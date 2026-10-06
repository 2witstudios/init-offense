/**
 * Whether a local TCP port is free for a dev server, shared by the wizard
 * (cli/wizard-io.ts) and slot:up's port-block pick (scripts/slot.ts).
 *
 * A port counts as free only when it binds on 127.0.0.1, 0.0.0.0 and ::.
 * Each address catches a listener the others miss on macOS: a Docker port
 * published on 127.0.0.1 leaves both wildcards bindable, while next dev
 * (on ::) and the realtime server (on 0.0.0.0) leave 127.0.0.1 bindable.
 */

/** Binds `hostname:port` and releases it at once; throws when it cannot. */
export type Bind = (hostname: string, port: number) => void;

const HOSTS = ['127.0.0.1', '0.0.0.0', '::'] as const;

/** A host without IPv6 answers :: with these; that is not a busy port. */
const NO_IPV6 = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);

const errorCode = (error: unknown): string =>
  error instanceof Error && 'code' in error ? String(error.code) : '';

/** The probe over a given `bind`, so tests can stand in for the kernel. */
export function portFreeWith(bind: Bind): (port: number) => boolean {
  return (port) =>
    HOSTS.every((hostname) => {
      try {
        bind(hostname, port);
        return true;
      } catch (error) {
        return hostname === '::' && NO_IPV6.has(errorCode(error));
      }
    });
}

const listenOnce: Bind = (hostname, port) =>
  Bun.listen({ hostname, port, socket: { data() {} } }).stop(true);

/** True when nothing listens on `port` on loopback or either wildcard. */
export const isPortFree = portFreeWith(listenOnce);
