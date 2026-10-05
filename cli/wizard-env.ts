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
} as const;

/**
 * The ports a main checkout's app port `p` occupies: the app, realtime
 * (p + 11) and the browser suite (p + 100 … p + 103); see
 * scripts/slot-ports.ts.
 */
const appPortFamily = (app: number): readonly number[] => [
  app,
  app + 11,
  app + 100,
  app + 101,
  app + 102,
  app + 103,
];

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

/**
 * Picks every local port, probing up from `starts`, never handing the same
 * port out twice.
 */
export function pickPorts(
  isFree: (port: number) => boolean,
  starts: Ports = DEFAULT_PORTS,
): Ports | null {
  const picked: number[] = [];
  const result: Partial<Record<keyof Ports, number>> = {};
  for (const [name, start] of Object.entries(starts)) {
    const family = name === 'app' ? appPortFamily : (port: number) => [port];
    const port = findFreePort(
      start,
      (candidate) => family(candidate).every(isFree),
      picked,
    );
    if (port === null) return null;
    picked.push(...family(port));
    result[name as keyof Ports] = port;
  }
  return result as Ports;
}

/** The compose port variables of a project: `WIDGET_APP_POSTGRES_PORT`, … */
export function stackPortKeys(slug: string): {
  readonly postgres: string;
  readonly redis: string;
  readonly app: string;
} {
  const prefix = nameForms({ slug, display: slug }).screaming;
  return {
    postgres: `${prefix}_POSTGRES_PORT`,
    redis: `${prefix}_REDIS_PORT`,
    app: `${prefix}_APP_PORT`,
  };
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
 * The .env values that point this project at `ports`: the compose port
 * variables, the main checkout's app port (which `bun slot:up` derives the
 * app, realtime and e2e ports from, so a later restart keeps them) and every
 * Postgres and Redis URL. `bun slot:up` keeps a URL's host and port.
 */
export function stackEnv(
  text: string,
  slug: string,
  ports: Ports,
): Record<string, string> {
  const keys = stackPortKeys(slug);
  return {
    [keys.postgres]: String(ports.postgres),
    [keys.redis]: String(ports.redis),
    ...(ports.app === DEFAULT_PORTS.app
      ? {}
      : { [keys.app]: String(ports.app) }),
    ...movedUrls(text, POSTGRES_URLS, ports.postgres),
    ...movedUrls(text, REDIS_URLS, ports.redis),
  };
}
