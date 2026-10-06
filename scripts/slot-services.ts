/**
 * The effectful plumbing of `bun slot:*` (ADR 0034), split from slot.ts:
 * which checkout and slot this is (from the ownership records), the live
 * worktrees, the admin Postgres
 * and Redis connections, orphan inspection and a checkout's own migrator.
 * db-reset and doctor reuse it; the commands themselves live in slot.ts.
 */
import { RedisClient, SQL } from 'bun';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { listSlotDatabases, type SlotDatabase } from '@acme/db/slots';
import { listNamespaces } from '@acme/redis/namespaces';
import { e2eRedisUrl } from './slot-env';
import {
  liveWorktreeIds,
  parseWorktreeList,
  serviceRefusal,
  type Slot,
} from './slot-model';
import {
  classifyCheckout,
  findOrphans,
  mainRecordOf,
  ownershipRefusal,
  recordedOwner,
} from './slot-ownership';
import { slotNaming } from './slot-naming';
import { withDatabase } from './slot-stack';
import { openOwnTestRedis } from './slot-redis';

const naming = slotNaming('acme');
export const worktreeDatabases = naming.worktreeDatabasePrefix;
const worktreeNamespaces = naming.worktreeNamespacePrefix;

export const run = async (
  command: readonly string[],
  cwd: string,
  env?: Record<string, string | undefined>,
): Promise<string> => {
  const child = Bun.spawn([...command], {
    cwd,
    env: env ?? process.env,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0)
    throw new Error(`${command.slice(0, 3).join(' ')} failed`);
  return output;
};

const realOrSame = (path: string) => realpath(path).catch(() => path);

/** Where a checkout is: its real path and its repository's main worktree. */
export type Location = {
  readonly path: string;
  readonly gitMain: string;
};

export type Checkout = Location & {
  readonly slot: Slot;
  /** True when this run (re)claims the main slot for this checkout. */
  readonly claimsMain: boolean;
};

/** The slot claims on the shared stack: every database named after the slug. */
export type SlotRecords = readonly SlotDatabase[];

// A recorded checkout is live while its path exists on disk.
const isLive = (path: string) => existsSync(path);

const readWorktrees = async (path: string) => {
  const list = parseWorktreeList(
    await run(['git', 'worktree', 'list', '--porcelain'], path),
  );
  return {
    main: await realOrSame(list.main),
    worktrees: await Promise.all(list.worktrees.map(realOrSame)),
  };
};

export async function locateCheckout(start: string): Promise<Location> {
  const path = await realOrSame(
    (await run(['git', 'rev-parse', '--show-toplevel'], start)).trim(),
  );
  return { path, gitMain: (await readWorktrees(path)).main };
}

export const readSlotRecords = (admin: SQL): Promise<SlotRecords> =>
  listSlotDatabases(admin, naming.databaseBase);

/**
 * The checkout's slot, decided from the ownership records (slot-ownership.ts):
 * throws a refusal rather than hand a checkout another checkout's slot.
 * Callers that change anything read the records under the slot lock.
 */
export function classify(
  location: Location,
  records: SlotRecords,
  claimMain = false,
): Checkout {
  const { slot, claimsMain } = classifyCheckout({
    checkout: location.path,
    gitMain: location.gitMain,
    main: mainRecordOf(records),
    isLive,
    claimMain,
  });
  const refusal = ownershipRefusal({
    slot,
    checkout: location.path,
    recorded: recordedOwner(records, slot.database),
    isLive,
  });
  if (refusal) throw new Error(refusal);
  return { ...location, slot, claimsMain };
}

/** Reads the records and classifies: the one call most commands need. */
export async function resolveCheckout(
  admin: SQL,
  location: Location,
  claimMain = false,
): Promise<Checkout> {
  return classify(location, await readSlotRecords(admin), claimMain);
}

export type SlotServices = {
  readonly admin: SQL;
  readonly connect: (database: string) => SQL;
  /** The dev (REDIS_URL) and e2e Redis databases every slot writes to. */
  readonly redis: readonly RedisClient[];
  /** This slot's own test Redis database (TEST_REDIS_URL), when .env names one. */
  readonly testRedis: RedisClient | undefined;
  readonly close: () => Promise<void>;
};

export function openServices(
  env: Readonly<Record<string, string | undefined>>,
): SlotServices {
  const refusal = serviceRefusal(env);
  if (refusal || !env.DATABASE_URL || !env.REDIS_URL)
    throw new Error(refusal ?? 'DATABASE_URL and REDIS_URL are required');
  const server = env.DATABASE_URL;
  const connect = (database: string) =>
    new SQL(withDatabase(server, database), { max: 1, connectionTimeout: 5 });
  const admin = connect('postgres');
  const redisUrls = [
    ...new Set([
      env.REDIS_URL,
      env.E2E_REDIS_URL ?? e2eRedisUrl(env.REDIS_URL),
    ]),
  ];
  const redis = redisUrls.map((url) => new RedisClient(url));
  const testRedis = openOwnTestRedis(env);
  return {
    admin,
    connect,
    redis,
    testRedis,
    close: async () => {
      for (const client of redis) client.close();
      testRedis?.close();
      await admin.close({ timeout: 5 });
    },
  };
}

/**
 * Orphaned slots on the shared stack. Read under the slot lock, right before
 * pruning, so a slot claimed while this run waited is never taken for one.
 * Only the main slot's own repository may drop slots that predate ownership
 * records, from its `git worktree list`; every checkout may drop a slot whose
 * recorded checkout no longer exists, and none ever drops a live one.
 */
export async function inspectOrphans(
  services: SlotServices,
  checkout: Checkout,
) {
  const records = await readSlotRecords(services.admin);
  const main = mainRecordOf(records);
  const ownsMainRepository =
    checkout.claimsMain ||
    (main.state === 'recorded' && main.checkout === checkout.gitMain);
  const legacyLiveIds = ownsMainRepository
    ? liveWorktreeIds((await readWorktrees(checkout.path)).worktrees).ids
    : undefined;
  const namespaces = [
    ...new Set(
      (
        await Promise.all(
          services.redis.map((client) =>
            listNamespaces(client, worktreeNamespaces),
          ),
        )
      ).flat(),
    ),
  ];
  return findOrphans({
    ownId: checkout.slot.kind === 'worktree' ? checkout.slot.id : undefined,
    databases: records.filter(({ name }) => name.startsWith(worktreeDatabases)),
    namespaces,
    isLive,
    legacyLiveIds,
  });
}

/** The checkout's own migrator: its branch may be behind or ahead of ours. */
export async function migratorOf(checkoutPath: string): Promise<string> {
  const migrator = join(checkoutPath, 'packages/db/scripts/migrate.ts');
  if (!(await Bun.file(migrator).exists()))
    throw new Error(`${migrator} is missing; cannot migrate this slot`);
  return migrator;
}

/** Applies the given checkout's own migrations with its own migrator. */
export async function migrate(
  databaseUrl: string,
  checkoutPath: string,
): Promise<void> {
  await run(['bun', await migratorOf(checkoutPath)], checkoutPath, {
    ...process.env,
    DATABASE_URL: databaseUrl,
  });
}
