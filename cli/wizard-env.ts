/**
 * Local ports for a freshly generated project (pure): free-port probing
 * over an injected `isFree`, and .env rewriting that touches only the keys
 * it owns and preserves every other line.
 */
import { nameForms } from './rename';

export const DEFAULT_PORTS = {
  postgres: 15432,
  redis: 6379,
  app: 3000,
  realtime: 3011,
} as const;

export type Ports = { readonly [K in keyof typeof DEFAULT_PORTS]: number };

const MAX_ATTEMPTS = 100;

/** The first port at or after `start` that `isFree` accepts and `taken` lacks. */
export function findFreePort(
  start: number,
  isFree: (port: number) => boolean,
  taken: readonly number[] = [],
): number | null {
  for (
    let port = start;
    port < start + MAX_ATTEMPTS && port <= 65_535;
    port += 1
  )
    if (!taken.includes(port) && isFree(port)) return port;
  return null;
}

/** Picks every local port, never handing the same port out twice. */
export function pickPorts(isFree: (port: number) => boolean): Ports | null {
  const picked: number[] = [];
  const result: Partial<Record<keyof Ports, number>> = {};
  for (const [name, start] of Object.entries(DEFAULT_PORTS)) {
    const port = findFreePort(start, isFree, picked);
    if (port === null) return null;
    picked.push(port);
    result[name as keyof Ports] = port;
  }
  return result as Ports;
}

/** The compose port variables of a project: `WIDGET_APP_POSTGRES_PORT`, … */
export function stackPortKeys(slug: string): {
  readonly postgres: string;
  readonly redis: string;
} {
  const prefix = nameForms({ slug, display: slug }).screaming;
  return { postgres: `${prefix}_POSTGRES_PORT`, redis: `${prefix}_REDIS_PORT` };
}

const assignment = (key: string) => new RegExp(`^${key}=(.*)$`, 'gm');

export function readEnv(text: string, key: string): string | undefined {
  return [...text.matchAll(assignment(key))].at(-1)?.[1];
}

/** Sets `KEY=value` lines in place, appending keys the text lacks. */
export function setEnv(
  text: string,
  values: Readonly<Record<string, string>>,
): string {
  let next = text;
  for (const [key, value] of Object.entries(values)) {
    if (readEnv(next, key) === undefined)
      next = `${next}${next && !next.endsWith('\n') ? '\n' : ''}${key}=${value}\n`;
    else next = next.replace(assignment(key), () => `${key}=${value}`);
  }
  return next;
}

const withPort = (url: string, port: number): string => {
  const next = new URL(url);
  next.port = String(port);
  return next.toString();
};

const POSTGRES_URLS = ['DATABASE_URL', 'TEST_DATABASE_URL', 'E2E_DATABASE_URL'];
const REDIS_URLS = ['REDIS_URL', 'TEST_REDIS_URL', 'E2E_REDIS_URL'];

const movedUrls = (text: string, keys: readonly string[], port: number) =>
  Object.fromEntries(
    keys.flatMap((key) => {
      const url = readEnv(text, key);
      return url ? [[key, withPort(url, port)]] : [];
    }),
  );

/**
 * The .env values that point this project's stack at `ports`: the compose
 * port variables plus every Postgres and Redis URL. `bun slot:up` keeps a
 * URL's host and port, so these survive it.
 */
export function stackEnv(
  text: string,
  slug: string,
  ports: Pick<Ports, 'postgres' | 'redis'>,
): Record<string, string> {
  const keys = stackPortKeys(slug);
  return {
    [keys.postgres]: String(ports.postgres),
    [keys.redis]: String(ports.redis),
    ...movedUrls(text, POSTGRES_URLS, ports.postgres),
    ...movedUrls(text, REDIS_URLS, ports.redis),
  };
}

/**
 * The app's own ports. `bun slot:up` resets these to the defaults in a main
 * checkout, so they are written after it runs, and only when they differ.
 */
export function appEnv(
  ports: Pick<Ports, 'app' | 'realtime'>,
): Record<string, string> {
  if (
    ports.app === DEFAULT_PORTS.app &&
    ports.realtime === DEFAULT_PORTS.realtime
  )
    return {};
  return {
    PORT: String(ports.app),
    PUBLIC_APP_URL: `http://localhost:${ports.app}`,
    REALTIME_PORT: String(ports.realtime),
  };
}
